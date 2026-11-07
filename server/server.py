import os
import io
import uuid
import json
import shutil
import base64
import threading
import yaml
from flask import Flask, request, jsonify
from flask_cors import CORS
from PIL import Image
from ultralytics import YOLO
from pillow_heif import register_heif_opener
from pyngrok import ngrok

register_heif_opener()

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, 'best.pt')
BACKUP_MODEL_PATH = os.path.join(BASE_DIR, 'best_backup.pt')

DATASET_DIR = os.path.join(BASE_DIR, 'dataset')
IMAGES_DIR = os.path.join(DATASET_DIR, 'images')
LABELS_DIR = os.path.join(DATASET_DIR, 'labels')
HOLDS_DATA_DIR = os.path.join(DATASET_DIR, 'holds_data')
POSE_DATA_DIR = os.path.join(DATASET_DIR, 'pose_data')
DATA_YAML_PATH = os.path.join(DATASET_DIR, 'data.yaml')
RUNS_DIR = os.path.join(BASE_DIR, 'runs')

# --- CREATE DATASET FOLDERS ---
os.makedirs(IMAGES_DIR, exist_ok=True)
os.makedirs(LABELS_DIR, exist_ok=True)
os.makedirs(HOLDS_DATA_DIR, exist_ok=True)
os.makedirs(POSE_DATA_DIR, exist_ok=True)

model_lock = threading.Lock()
model = YOLO(MODEL_PATH)

training_lock = threading.Lock()
is_training = False
pending_retrain = False

DEFAULT_HOLD_TYPES = ["Jug", "Crimp", "Pinch", "Sloper", "Pocket", "Volume"]

technique_guide = {
    "Jug": "Rest spot! Shake out your arms here.",
    "Crimp": "Keep hips tight to the wall. Open-hand grip if possible.",
    "Pinch": "Engage your thumb! Squeeze hard.",
    "Sloper": "Stay low! Keep your arms straight and rely on friction.",
    "Volume": "Trust your feet. Smear or palm press.",
    "Pocket": "Watch your tendons.",
    "hold": "Just go for it!"
}


def get_label_to_id_map():
    """Build a case-insensitive mapping from label name to YOLO class ID."""
    with model_lock:
        names = dict(model.names) if hasattr(model, 'names') and model.names else {}

    if not names:
        names = {i: name for i, name in enumerate(DEFAULT_HOLD_TYPES)}

    label_to_id = {}
    for cls_id, cls_name in names.items():
        label_to_id[str(cls_name).strip().lower()] = int(cls_id)

    return names, label_to_id


def ensure_data_yaml(names_dict):
    """Create or update the Ultralytics dataset YAML file."""
    yaml_content = {
        'path': DATASET_DIR,
        'train': 'images',
        'val': 'images',
        'names': {int(k): str(v) for k, v in names_dict.items()}
    }
    with open(DATA_YAML_PATH, 'w') as f:
        yaml.safe_dump(yaml_content, f, sort_keys=True)


def write_yolo_annotations(climb_id, holds):
    """
    Convert hold percentage coordinates (top-left x, y, w, h in 0..100)
    into normalized YOLO format: <class_id> <x_center> <y_center> <width> <height> (0.0..1.0).
    """
    names_dict, label_to_id = get_label_to_id_map()
    ensure_data_yaml(names_dict)

    lines = []
    for hold in holds:
        # Use user-corrected label if modified or selected; otherwise keep original model prediction
        chosen_label = hold.get('label') if (hold.get('userModified') or hold.get('isSelected')) else (hold.get('original_label') or hold.get('label'))
        if not chosen_label:
            continue

        cls_id = label_to_id.get(str(chosen_label).strip().lower())
        if cls_id is None:
            continue

        w_norm = max(0.001, min(1.0, float(hold.get('w', 0)) / 100.0))
        h_norm = max(0.001, min(1.0, float(hold.get('h', 0)) / 100.0))
        x_center = max(0.0, min(1.0, (float(hold.get('x', 0)) / 100.0) + (w_norm / 2.0)))
        y_center = max(0.0, min(1.0, (float(hold.get('y', 0)) / 100.0) + (h_norm / 2.0)))

        lines.append(f"{cls_id} {x_center:.6f} {y_center:.6f} {w_norm:.6f} {h_norm:.6f}")

    label_path = os.path.join(LABELS_DIR, f"climb_{climb_id}.txt")
    with open(label_path, 'w') as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))

    return label_path, len(lines)


def _background_train_worker():
    """Run incremental YOLO fine-tuning in the background and hot-reload best.pt."""
    global model, is_training, pending_retrain

    while True:
        with training_lock:
            if not pending_retrain:
                is_training = False
                return
            pending_retrain = False

        try:
            label_files = [
                f for f in os.listdir(LABELS_DIR)
                if f.endswith('.txt') and os.path.getsize(os.path.join(LABELS_DIR, f)) > 0
            ]
            if not label_files:
                print("⚠️ No non-empty YOLO label files found; skipping fine-tuning.")
                continue

            print(f"🧠 Starting continual YOLO fine-tuning on {len(label_files)} sample(s)...")

            # Backup current model weights before fine-tuning
            if os.path.exists(MODEL_PATH):
                shutil.copy2(MODEL_PATH, BACKUP_MODEL_PATH)

            # Use a separate YOLO instance so live /detect requests are not blocked during training
            trainer_model = YOLO(MODEL_PATH)
            trainer_model.train(
                data=DATA_YAML_PATH,
                epochs=5,
                imgsz=640,
                batch=min(4, max(1, len(label_files))),
                lr0=0.0005,
                lrf=0.1,
                warmup_epochs=0,
                mosaic=0.0,
                project=RUNS_DIR,
                name='continual_train',
                exist_ok=True,
                verbose=False
            )

            trained_best = os.path.join(RUNS_DIR, 'continual_train', 'weights', 'best.pt')
            trained_last = os.path.join(RUNS_DIR, 'continual_train', 'weights', 'last.pt')
            new_weights = trained_best if os.path.exists(trained_best) else trained_last

            if os.path.exists(new_weights):
                shutil.copy2(new_weights, MODEL_PATH)
                with model_lock:
                    model = YOLO(MODEL_PATH)
                print("✅ Continual fine-tuning complete! Hot-reloaded updated best.pt.")
            else:
                print("⚠️ Fine-tuning finished, but updated weight file was not found.")

        except Exception as e:
            print(f"❌ Background fine-tuning error: {e}")


def trigger_background_training():
    """Queue a fine-tuning pass without blocking the HTTP response."""
    global is_training, pending_retrain
    with training_lock:
        pending_retrain = True
        if not is_training:
            is_training = True
            worker = threading.Thread(target=_background_train_worker, daemon=True)
            worker.start()


@app.route('/detect', methods=['POST'])
def detect():
    data = request.get_json()
    if not data or 'image' not in data:
        return jsonify({'error': 'No image sent'}), 400

    try:
        image_bytes = base64.b64decode(data['image'])
        img = Image.open(io.BytesIO(image_bytes))
        if img.mode != 'RGB':
            img = img.convert('RGB')
    except Exception as e:
        print(f"Image decode error: {e}")
        return jsonify({'error': 'Invalid image data'}), 400

    with model_lock:
        results = model(img, conf=0.35)
        names_map = dict(model.names)

    detected_objects = []
    width, height = img.size
    result = results[0]

    if len(result.boxes) == 0:
        return jsonify({"holds": []})

    hold_data = []
    total_area_for_avg = 0
    count_for_avg = 0

    for box in result.boxes:
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        w_px = x2 - x1
        h_px = y2 - y1
        area = w_px * h_px

        class_id = int(box.cls[0])
        conf_score = float(box.conf[0]) if box.conf is not None else 0.5
        original_label = names_map[class_id]

        hold_data.append({
            "x1": x1, "y1": y1, "w_px": w_px, "h_px": h_px,
            "area": area, "original_label": original_label,
            "conf": conf_score
        })

        if original_label != "Volume":
            total_area_for_avg += area
            count_for_avg += 1

    avg_area = total_area_for_avg / count_for_avg if count_for_avg > 0 else 0

    for hold in hold_data:
        original_label = hold["original_label"]
        final_label = original_label
        area_pct = (hold["area"] / (width * height)) * 100

        # Only apply size/type fallback heuristics when the model is uncertain (conf < 0.65),
        # so high-confidence predictions learned from user corrections are respected.
        if original_label != "Volume" and hold["conf"] < 0.65:
            if final_label == "Pocket":
                final_label = "Crimp"
            if area_pct > 8.0 and final_label == "Crimp":
                final_label = "Sloper"
            if avg_area > 0 and hold["area"] < (avg_area * 0.35) and final_label == "Jug":
                final_label = "Crimp"

        display_label = f"AI: {original_label} ➔ Logic: {final_label}" if original_label != final_label else final_label
        tip = technique_guide.get(final_label, "Pull hard!")

        obj = {
            "id": str(len(detected_objects)),
            "x": (hold["x1"] / width) * 100,
            "y": (hold["y1"] / height) * 100,
            "w": (hold["w_px"] / width) * 100,
            "h": (hold["h_px"] / height) * 100,
            "label": final_label,
            "original_label": original_label,
            "conf": round(hold["conf"], 3),
            "userModified": False,
            "display_label": display_label,
            "technique": tip
        }
        detected_objects.append(obj)

    detected_objects.sort(key=lambda item: item['w'] * item['h'], reverse=True)
    return jsonify({"holds": detected_objects})


@app.route('/save', methods=['POST'])
def save_dataset():
    try:
        # Support both JSON payload (from index.tsx) and multipart/form-data
        if request.is_json:
            payload_data = request.get_json()
            if not payload_data or 'image' not in payload_data:
                return jsonify({'error': 'Missing image in JSON payload'}), 400

            climb_id = payload_data.get('climb_id') or uuid.uuid4().hex[:12]
            image_bytes = base64.b64decode(payload_data['image'])
            img = Image.open(io.BytesIO(image_bytes))
            if img.mode != 'RGB':
                img = img.convert('RGB')

            image_path = os.path.join(IMAGES_DIR, f"climb_{climb_id}.jpg")
            img.save(image_path, format='JPEG', quality=95)
        else:
            if 'image' not in request.files or 'data' not in request.form:
                return jsonify({'error': 'Missing image or data payload'}), 400

            image_file = request.files['image']
            payload_data = json.loads(request.form['data'])
            climb_id = payload_data.get('climb_id') or uuid.uuid4().hex[:12]

            image_path = os.path.join(IMAGES_DIR, f"climb_{climb_id}.jpg")
            image_file.save(image_path)

        corrected_holds = payload_data.get('corrected_holds', [])
        all_holds = payload_data.get('all_holds') or corrected_holds

        holds_path = os.path.join(HOLDS_DATA_DIR, f"climb_{climb_id}_holds.json")
        with open(holds_path, 'w') as f:
            json.dump({
                'climb_id': climb_id,
                'corrected_holds': corrected_holds,
                'all_holds': all_holds
            }, f, indent=4)

        pose_path = os.path.join(POSE_DATA_DIR, f"climb_{climb_id}_pose.json")
        with open(pose_path, 'w') as f:
            json.dump(payload_data.get('beta_frames', []), f, indent=4)

        # Write YOLO-formatted label file (.txt) for training
        label_path, box_count = write_yolo_annotations(climb_id, all_holds)
        print(f"✅ Saved climb {climb_id}: {len(corrected_holds)} corrected hold(s), {box_count} total YOLO boxes -> {label_path}")

        should_train = payload_data.get('trigger_train', True) and len(corrected_holds) > 0
        if should_train:
            trigger_background_training()

        return jsonify({
            'success': True,
            'climb_id': climb_id,
            'yolo_boxes_written': box_count,
            'training_triggered': should_train
        })

    except Exception as e:
        print(f"❌ Server Error during save: {e}")
        return jsonify({'error': str(e)}), 500


def setup_ngrok():
    ngrok.set_auth_token("3A8EzLqo6JrGJH3BUGBvGBy20dn_3o1KjWmKLC6AWVza2TRR")
    tunnel = ngrok.connect(5000)
    public_url = tunnel.public_url
    print(f"🚀 Ngrok Tunnel Active: {public_url}")

    config_path = os.path.join(BASE_DIR, '..', 'ClimbingApp', 'ngrok_url.json')
    try:
        with open(config_path, "w") as f:
            json.dump({"NGROK_URL": f"{public_url}/detect"}, f, indent=2)
        print(f"✅ Saved tunnel configuration to {config_path}")
    except Exception as err:
        print(f"⚠️ Could not write ngrok_url.json: {err}")


if __name__ == '__main__':
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        setup_ngrok()

    app.run(host='0.0.0.0', port=5000, debug=True)