import ngrokConfig from '../../ngrok_url.json';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import MaskedView from '@react-native-masked-view/masked-view';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import Constants from 'expo-constants';
import { useNavigation } from 'expo-router';
import React, { useState, useRef, useEffect } from 'react';
import { BlurView } from 'expo-blur';
import {
    Button,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    Image,
    Alert,
    Dimensions,
    Animated,
    LayoutAnimation,
    Platform,
    UIManager,
    PanResponder,
    Pressable
} from 'react-native';

const HOLD_TYPES = ["Jug", "Crimp", "Pinch", "Sloper", "Pocket", "Volume"];
const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
    UIManager.setLayoutAnimationEnabledExperimental(true);
}

const HOLD_WEIGHTS: Record<string, number> = {
    "Jug": 1.0, "Volume": 2.0, "Pinch": 3.5, "Sloper": 5.0, "Crimp": 6.0, "Pocket": 7.0, "hold": 3.0
};

// --- ISOLATED HOLD COMPONENT FOR INDIVIDUAL GLOW-UPS ---
const HoldBox = ({ box, index, step, startData, isTop, isPath, isEditing, onHoldClick }: any) => {
    const isStart = !!startData;
    const isSelected = isStart || isTop || isPath;

    if (box.label === 'Volume' && !box.userModified) return null;
    if ((step === 'EDIT' || step === 'SUMMARY') && !isSelected) return null;

    let borderColor = 'rgba(255,255,255,0.4)';
    let tintColor = 'transparent';
    let borderWidth = isSelected ? 3 : 1.5;
    let labelColor = '#999';

    if (isStart) {
        borderColor = startData.clicks === 1 ? '#39FF14' : '#008000';
        tintColor = startData.clicks === 1 ? 'rgba(57, 255, 20, 0.25)' : 'rgba(0, 128, 0, 0.45)';
        labelColor = borderColor;
    } else if (isTop) {
        borderColor = '#FF003F';
        tintColor = 'rgba(255, 0, 63, 0.25)';
        labelColor = borderColor;
    } else if (isPath) {
        borderColor = '#FFE600';
        tintColor = 'rgba(255, 230, 0, 0.25)';
        labelColor = borderColor;
    }

    if (isEditing) {
        borderColor = '#0A84FF';
        borderWidth = 4;
        tintColor = 'rgba(10, 132, 255, 0.3)';
    }

    const glowOpacity = useRef(new Animated.Value(isSelected || isEditing ? 1 : 0)).current;
    const prevClicks = useRef(startData?.clicks);

    useEffect(() => {
        if (isSelected || isEditing) {
            Animated.timing(glowOpacity, {
                toValue: 1,
                duration: 400,
                useNativeDriver: true
            }).start();
        } else {
            glowOpacity.setValue(0);
        }
    }, [isSelected, isEditing]);

    useEffect(() => {
        if (isStart && prevClicks.current === 1 && startData.clicks === 2) {
            glowOpacity.setValue(0.2);
            Animated.timing(glowOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
        }
        prevClicks.current = startData?.clicks;
    }, [startData?.clicks, isStart]);

    return (
        <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => onHoldClick(index)}
            style={[styles.box, {
                left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%`,
                zIndex: isSelected || isEditing ? 15 : 5,
                borderWidth: (isSelected || isEditing) ? 0 : 1.5,
                borderColor: (isSelected || isEditing) ? 'transparent' : 'rgba(255,255,255,0.4)'
            }]}
        >
            <Animated.View style={[StyleSheet.absoluteFill, {
                borderRadius: 8,
                borderWidth: borderWidth,
                borderColor: borderColor,
                backgroundColor: tintColor,
                opacity: glowOpacity
            }]} />

            {(step === 'EDIT' || step === 'SUMMARY') && isSelected && (
                <View style={[styles.miniTag, { borderColor: labelColor }]}>
                    <Text style={styles.miniTagText}>{box.label.charAt(0)}</Text>
                </View>
            )}
        </TouchableOpacity>
    );
};

export default function App() {
    const navigation = useNavigation();
    useEffect(() => {
        navigation.setOptions({ headerShown: false });
    }, [navigation]);

    const [permission, requestPermission] = useCameraPermissions();
    const cameraRef = useRef<CameraView>(null);
    const [picture, setPicture] = useState<string | null>(null);
    const [imageBase64, setImageBase64] = useState<string | null>(null);
    const [climbId, setClimbId] = useState<string | null>(null);
    const [boxes, setBoxes] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);

    const [step, setStep] = useState<'START' | 'TOP' | 'ROUTE' | 'EDIT' | 'SUMMARY'>('START');
    const [startHolds, setStartHolds] = useState<{index: number, clicks: number}[]>([]);
    const [topHold, setTopHold] = useState<number | null>(null);
    const [pathHolds, setPathHolds] = useState<number[]>([]);
    const [editingHoldIndex, setEditingHoldIndex] = useState<number | null>(null);

    const [routeStats, setRouteStats] = useState({ grade: "V?", moves: 0, holds: 0 });

    const popoverOpacity = useRef(new Animated.Value(0)).current;
    const popoverScale = useRef(new Animated.Value(0.95)).current;

    const navTranslateX = useRef(new Animated.Value(0)).current;
    const navOpacity = useRef(new Animated.Value(1)).current;

    const loadingProgress = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if (loading) {
            loadingProgress.setValue(0);
            Animated.loop(
                Animated.sequence([
                    Animated.timing(loadingProgress, { toValue: 1, duration: 800, useNativeDriver: true }),
                    Animated.timing(loadingProgress, { toValue: 0, duration: 800, useNativeDriver: true })
                ])
            ).start();
        } else {
            loadingProgress.stopAnimation();
        }
    }, [loading]);

    const summaryTranslateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
    const dragOffset = useRef(0);
    const isAnimating = useRef(false);
    const SHEET_HEIGHT = 360;
    const HEADER_HEIGHT = 65;
    const SHEET_OFFSET = SHEET_HEIGHT - HEADER_HEIGHT;

    function toggleSummaryCard() {
        if (isAnimating.current) return;
        isAnimating.current = true;

        const currentY = (summaryTranslateY as any)._value;
        const targetY = currentY > (SHEET_OFFSET / 2) ? 0 : SHEET_OFFSET;

        summaryTranslateY.flattenOffset();

        Animated.spring(summaryTranslateY, {
            toValue: targetY,
            bounciness: 6,
            useNativeDriver: true
        }).start(() => {
            isAnimating.current = false;
        });
    }

    const summaryPan = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => false,
            onMoveShouldSetPanResponder: (_, gestureState) => Math.abs(gestureState.dy) > 10,
            onPanResponderGrant: () => {
                summaryTranslateY.stopAnimation((currentValue) => {
                    dragOffset.current = currentValue;
                    summaryTranslateY.setOffset(currentValue);
                    summaryTranslateY.setValue(0);
                });
            },
            onPanResponderMove: (_, gestureState) => {
                const absoluteY = dragOffset.current + gestureState.dy;

                if (absoluteY < 0) {
                    const resistedY = absoluteY * 0.1;
                    summaryTranslateY.setValue(resistedY - dragOffset.current);
                } else if (absoluteY > SHEET_OFFSET) {
                    const overDrag = absoluteY - SHEET_OFFSET;
                    const resistedY = SHEET_OFFSET + (overDrag * 0.1);
                    summaryTranslateY.setValue(resistedY - dragOffset.current);
                } else {
                    summaryTranslateY.setValue(gestureState.dy);
                }
            },
            onPanResponderRelease: (_, gestureState) => {
                summaryTranslateY.flattenOffset();
                const currentY = (summaryTranslateY as any)._value;
                let targetY: number;

                if (gestureState.dy > 30 || gestureState.vy > 0.5) targetY = SHEET_OFFSET;
                else if (gestureState.dy < -30 || gestureState.vy < -0.5) targetY = 0;
                else targetY = currentY > (SHEET_OFFSET / 2) ? SHEET_OFFSET : 0;

                Animated.spring(summaryTranslateY, {
                    toValue: targetY,
                    bounciness: 6,
                    useNativeDriver: true
                }).start();
            }
        })
    ).current;

    useEffect(() => {
        if (step === 'SUMMARY') {
            summaryTranslateY.setValue(SCREEN_HEIGHT);
            Animated.spring(summaryTranslateY, { toValue: 0, bounciness: 6, useNativeDriver: true }).start();
        }
    }, [step]);

    useEffect(() => {
        if (editingHoldIndex !== null) {
            Animated.parallel([
                Animated.timing(popoverOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
                Animated.spring(popoverScale, { toValue: 1, friction: 6, useNativeDriver: true })
            ]).start();
        }
    }, [editingHoldIndex]);

    function closeEditMenu() {
        Animated.parallel([
            Animated.timing(popoverOpacity, { toValue: 0, duration: 100, useNativeDriver: true }),
            Animated.timing(popoverScale, { toValue: 0.95, duration: 100, useNativeDriver: true })
        ]).start(() => setEditingHoldIndex(null));
    }

    if (!permission) return <View />;
    if (!permission.granted) {
        return (
            <View style={styles.container}>
                <Text style={{color:'white', textAlign:'center', marginBottom: 20}}>We need camera access!</Text>
                <Button onPress={requestPermission} title="Grant Permission" />
            </View>
        );
    }

    async function takePicture() {
        if (cameraRef.current) {
            setLoading(true);
            const photo = await cameraRef.current.takePictureAsync({ quality: 0.5 });
            setPicture(photo.uri);
            detectHolds(photo.uri);
        }
    }

    async function pickImage() {
        let result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
        if (!result.canceled) {
            setLoading(true);
            const uri = result.assets[0].uri;
            setPicture(uri);
            detectHolds(uri);
        }
    }

    const fetchWithTimeout = async (url: string, options: any, timeout = 2500) => {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    };

    function getServerEndpoints(path: '/detect' | '/save') {
        const hostUri = Constants.expoConfig?.hostUri;
        const pcIp = hostUri ? hostUri.split(':')[0] : '127.0.0.1';
        const localUrl = `http://${pcIp}:5000${path}`;
        const ngrokBase = (ngrokConfig.NGROK_URL || '').replace(/\/detect\/?$/, '');
        const ngrokUrl = `${ngrokBase}${path}`;
        return { localUrl, ngrokUrl };
    }

    async function postToServer(path: '/detect' | '/save', payload: any) {
        const body = JSON.stringify(payload);
        const headers = {
            'Content-Type': 'application/json',
            'ngrok-skip-browser-warning': 'true',
        };
        const { localUrl, ngrokUrl } = getServerEndpoints(path);

        try {
            return await fetchWithTimeout(localUrl, { method: 'POST', body, headers }, 2500);
        } catch {
            return await fetch(ngrokUrl, { method: 'POST', body, headers });
        }
    }

    async function detectHolds(imageUri: string) {
        try {
            const base64 = await FileSystem.readAsStringAsync(imageUri, {
                encoding: FileSystem.EncodingType.Base64,
            });
            setImageBase64(base64);
            const newClimbId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            setClimbId(newClimbId);

            const response = await postToServer('/detect', { image: base64 });
            const rawText = await response.text();
            console.log("Server raw response:", rawText);

            let data;
            try {
                data = JSON.parse(rawText);
            } catch {
                Alert.alert("Server Error", `Non-JSON response:\n${rawText.slice(0, 300)}`);
                setLoading(false);
                return;
            }

            if (!response?.ok) {
                Alert.alert("Error", data.error);
                setLoading(false);
                return;
            }

            setBoxes(data.holds || []);
            softReset();
        } catch (error: any) {
            console.error("Detect holds failed:", error);
            Alert.alert("Network/Server Error", error?.message || String(error));
            setLoading(false);
        }
    }

    async function syncCorrectionsToModel(currentBoxes: any[], triggerTrain = true) {
        const hasCorrections = currentBoxes.some(b => b.userModified);
        if (!hasCorrections || !imageBase64) return;

        const selectedIndices = new Set<number>([
            ...startHolds.map(h => h.index),
            ...(topHold !== null ? [topHold] : []),
            ...pathHolds
        ]);

        const holdsPayload = currentBoxes.map((box, idx) => ({
            ...box,
            isSelected: selectedIndices.has(idx),
            userModified: !!box.userModified
        }));

        try {
            const response = await postToServer('/save', {
                climb_id: climbId,
                image: imageBase64,
                all_holds: holdsPayload,
                corrected_holds: holdsPayload.filter(h => h.userModified),
                trigger_train: triggerTrain
            });
            const result = await response.json();
            console.log("Model feedback saved:", result);
        } catch (err) {
            console.warn("Could not sync hold corrections to server:", err);
        }
    }

    function hardReset() {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setPicture(null);
        setImageBase64(null);
        setClimbId(null);
        setBoxes([]);
        softReset();
    }

    function softReset() {
        setStep('START'); setStartHolds([]); setTopHold(null); setPathHolds([]);
        setEditingHoldIndex(null); setLoading(false);
        navTranslateX.setValue(0);
        navOpacity.setValue(1);
    }

    function handleHoldClick(index: number) {
        if (step === 'START') {
            const existing = startHolds.find(h => h.index === index);
            if (existing) {
                if (existing.clicks === 1) {
                    setStartHolds(startHolds.map(h => h.index === index ? { ...h, clicks: 2 } : h));
                } else {
                    setStartHolds(startHolds.filter(h => h.index !== index));
                }
            } else {
                if (startHolds.length < 2) {
                    setStartHolds([...startHolds, { index, clicks: 1 }]);
                } else {
                    Alert.alert("Limit Reached", "Max 2 starting holds.");
                }
            }
        }
        else if (step === 'TOP') {
            if (topHold === index) setTopHold(null); else setTopHold(index);
        }
        else if (step === 'ROUTE') {
            if (pathHolds.includes(index)) setPathHolds(pathHolds.filter(i => i !== index));
            else setPathHolds([...pathHolds, index]);
        }
        else if (step === 'EDIT' || step === 'SUMMARY') {
            const isSelected = startHolds.some(h => h.index === index) || topHold === index || pathHolds.includes(index);
            if (isSelected) setEditingHoldIndex(index);
        }
    }

    function changeHoldType(newType: string) {
        if (editingHoldIndex === null) return;
        const updatedBoxes = boxes.map((box, idx) =>
            idx === editingHoldIndex
                ? { ...box, label: newType, userModified: true }
                : box
        );
        setBoxes(updatedBoxes);
        closeEditMenu();

        // Save the correction immediately; trigger fine-tuning right away if on SUMMARY,
        // or wait until the user taps "Analyze" if still reviewing on EDIT.
        syncCorrectionsToModel(updatedBoxes, step === 'SUMMARY');

        if (step === 'SUMMARY') updateRouteStats(updatedBoxes);
    }

    function calculateVGrade(sequence: number[][], currentBoxes: any[]) {
        if (!sequence || sequence.length < 2) return { grade: "V0", moves: 0 };
        let totalScore = 0; let moveCount = 0;

        const wallVolumes = currentBoxes.filter(b => b.label === 'Volume');

        for (let i = 1; i < sequence.length; i++) {
            const prevMove = sequence[i-1]; const currMove = sequence[i];
            let px = 0, py = 0;
            prevMove.forEach(idx => { px += currentBoxes[idx].x + currentBoxes[idx].w/2; py += currentBoxes[idx].y + currentBoxes[idx].h/2; });
            px /= prevMove.length; py /= prevMove.length;

            let cxPos = 0, cyPos = 0, maxHoldWeight = 0;
            currMove.forEach(idx => {
                cxPos += currentBoxes[idx].x + currentBoxes[idx].w/2; cyPos += currentBoxes[idx].y + currentBoxes[idx].h/2;
                maxHoldWeight = Math.max(maxHoldWeight, HOLD_WEIGHTS[currentBoxes[idx].label] || 3.0);
            });
            cxPos /= currMove.length; cyPos /= currMove.length;

            const dist = Math.sqrt(Math.pow(cxPos - px, 2) + Math.pow(cyPos - py, 2));
            let distanceMultiplier = Math.max(1.0, dist / 12);

            let volumeAssist = 0;
            const midX = (px + cxPos) / 2;
            const midY = (py + cyPos) / 2;

            wallVolumes.forEach(vol => {
                const volCenterY = vol.y + vol.h/2;
                const isBelow = volCenterY > midY;          // larger y = lower on the wall

                // distance from midpoint to the volume's nearest edge, not its center
                const nearestX = Math.max(vol.x, Math.min(midX, vol.x + vol.w));
                const nearestY = Math.max(vol.y, Math.min(midY, vol.y + vol.h));
                const distToVol = Math.sqrt(Math.pow(midX - nearestX, 2) + Math.pow(midY - nearestY, 2));

                if (isBelow && distToVol < 20) volumeAssist = 0.5;
            });

            distanceMultiplier = Math.max(1.0, distanceMultiplier - volumeAssist);
            totalScore += (maxHoldWeight * distanceMultiplier);
            moveCount++;
        }

        const avgMoveScore = totalScore / moveCount;
        let finalGrade = "V8+";
        if (avgMoveScore < 1.8) finalGrade = "V0"; else if (avgMoveScore < 2.5) finalGrade = "V1";
        else if (avgMoveScore < 3.5) finalGrade = "V2"; else if (avgMoveScore < 4.8) finalGrade = "V3";
        else if (avgMoveScore < 6.2) finalGrade = "V4"; else if (avgMoveScore < 7.5) finalGrade = "V5";
        else if (avgMoveScore < 9.0) finalGrade = "V6"; else if (avgMoveScore < 11.0) finalGrade = "V7";

        return { grade: finalGrade, moves: moveCount };
    }

    function updateRouteStats(currentBoxes: any[]) {
        const lowestStartY = Math.max(...startHolds.map(h => currentBoxes[h.index].y));
        const handPath = pathHolds.filter(idx => currentBoxes[idx].y <= lowestStartY + 2);
        const sortedHands = handPath.sort((a, b) => currentBoxes[b].y - currentBoxes[a].y);

        const sequence = [
            startHolds.map(h => h.index),
            ...sortedHands.map(h => [h]),
            [topHold as number]
        ];

        const stats = calculateVGrade(sequence, currentBoxes);
        const totalHolds = startHolds.length + sortedHands.length + 1;
        setRouteStats({ grade: stats.grade, moves: stats.moves, holds: totalHolds });
    }

    function animateNav(direction: 'next' | 'back', nextStep: any) {
        const outX = direction === 'next' ? -50 : 50;
        const inX = direction === 'next' ? 50 : -50;

        Animated.parallel([
            Animated.timing(navTranslateX, { toValue: outX, duration: 150, useNativeDriver: true }),
            Animated.timing(navOpacity, { toValue: 0, duration: 150, useNativeDriver: true })
        ]).start(() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setStep(nextStep);
            navTranslateX.setValue(inX);
            Animated.parallel([
                Animated.timing(navTranslateX, { toValue: 0, duration: 150, useNativeDriver: true }),
                Animated.timing(navOpacity, { toValue: 1, duration: 150, useNativeDriver: true })
            ]).start();
        });
    }

    function goNextStep() {
        if (step === 'START') {
            if (startHolds.length === 0) {
                return Alert.alert("Wait!", "Please select at least 1 starting hold.");
            }
            animateNav('next', 'TOP');
        } else if (step === 'TOP') {
            if (topHold === null) {
                return Alert.alert("Wait!", "Please select a top hold.");
            }
            animateNav('next', 'ROUTE');
        } else if (step === 'ROUTE') {
            animateNav('next', 'EDIT');
        } else if (step === 'EDIT') {
            updateRouteStats(boxes);
            syncCorrectionsToModel(boxes, true);
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setStep('SUMMARY');
        }
    }

    function goBackStep() {
        if (step === 'SUMMARY') {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setStep('EDIT');
            navTranslateX.setValue(0);
            navOpacity.setValue(1);
        } else if (step === 'EDIT') {
            closeEditMenu();
            animateNav('back', 'ROUTE');
        } else if (step === 'ROUTE') {
            animateNav('back', 'TOP');
        } else if (step === 'TOP') {
            animateNav('back', 'START');
        }
    }

    let popoverStyle = {};
    if (editingHoldIndex !== null) {
        const box = boxes[editingHoldIndex];
        popoverStyle = {
            left: (SCREEN_WIDTH - 300) / 2,
            ...(box.y < 50 ? { top: `${box.y + box.h + 2}%` } : { bottom: `${100 - box.y + 2}%` })
        };
    }

    let cx = 50, cy = 50, rx = 40, ry = 40;
    if (step === 'EDIT' || step === 'SUMMARY') {
        const selectedBoxes = boxes.filter((b, i) => startHolds.some(h => h.index === i) || topHold === i || pathHolds.includes(i));
        if (selectedBoxes.length > 0) {
            const minX = Math.min(...selectedBoxes.map(b => b.x));
            const minY = Math.min(...selectedBoxes.map(b => b.y));
            const maxX = Math.max(...selectedBoxes.map(b => b.x + b.w));
            const maxY = Math.max(...selectedBoxes.map(b => b.y + b.h));
            cx = minX + (maxX - minX) / 2;
            cy = minY + (maxY - minY) / 2;
            rx = ((maxX - minX) / 2) + 15;
            ry = ((maxY - minY) / 2) + 15;
        }
    }

    if (picture) {
        return (
            <View style={styles.container}>
                <View style={StyleSheet.absoluteFill}>

                    <Image source={{ uri: picture }} style={StyleSheet.absoluteFill} resizeMode="stretch" />

                    {(step === 'EDIT' || step === 'SUMMARY') && (
                        <MaskedView
                            style={StyleSheet.absoluteFill}
                            maskElement={
                                <Svg width="100%" height="100%">
                                    <Defs>
                                        <RadialGradient id="blurMask" cx={`${cx}%`} cy={`${cy}%`} rx={`${rx}%`} ry={`${ry}%`} fx={`${cx}%`} fy={`${cy}%`}>
                                            <Stop offset="50%" stopColor="black" stopOpacity="0" />
                                            <Stop offset="100%" stopColor="black" stopOpacity="1" />
                                        </RadialGradient>
                                    </Defs>
                                    <Rect x="0" y="0" width="100%" height="100%" fill="url(#blurMask)" />
                                </Svg>
                            }
                        >
                            <Image source={{ uri: picture }} style={StyleSheet.absoluteFill} resizeMode="stretch" blurRadius={10} />
                        </MaskedView>
                    )}

                    {!loading && boxes.map((box, index) => {
                        const startData = startHolds.find(h => h.index === index);
                        const isTop = topHold === index;
                        const isPath = pathHolds.includes(index);
                        const isEditing = editingHoldIndex === index;

                        return (
                            <HoldBox
                                key={index}
                                box={box}
                                index={index}
                                step={step}
                                startData={startData}
                                isTop={isTop}
                                isPath={isPath}
                                isEditing={isEditing}
                                onHoldClick={handleHoldClick}
                            />
                        );
                    })}

                    {loading && (
                        <BlurView intensity={100} tint="dark" style={styles.loaderOverlay}>
                            <View style={styles.loadingTrack}>
                                <Animated.View style={[styles.loadingIndicator, {
                                    transform: [{
                                        translateX: loadingProgress.interpolate({
                                            inputRange: [0, 1],
                                            outputRange: [0, 90]
                                        })
                                    }]}]}
                                />
                            </View>
                            <Text style={styles.loadingText}>Analyzing Route</Text>
                        </BlurView>
                    )}

                    {editingHoldIndex !== null && (
                        <View style={[StyleSheet.absoluteFill, { zIndex: 100 }]} pointerEvents="box-none">
                            <Pressable style={StyleSheet.absoluteFill} onPress={closeEditMenu} />

                            <Animated.View style={[styles.popoverMenu, popoverStyle, { opacity: popoverOpacity, transform: [{ scale: popoverScale }] }]} pointerEvents="box-none">
                                <View style={styles.gridContainer}>
                                    {HOLD_TYPES.map((type) => {
                                        const isCurrentAI = boxes[editingHoldIndex].label === type;
                                        return (
                                            <TouchableOpacity key={type} style={[styles.gridButton, isCurrentAI && styles.gridButtonActive]} onPress={() => changeHoldType(type)}>
                                                <Text style={[styles.gridButtonText, isCurrentAI && styles.gridButtonTextActive]}>{type}</Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>
                            </Animated.View>
                        </View>
                    )}
                </View>

                <View style={styles.bottomOverlayContainer} pointerEvents="box-none">
                    {step === 'SUMMARY' ? (
                        <Animated.View style={[styles.summaryCard, { transform: [{ translateY: summaryTranslateY }] }]} {...summaryPan.panHandlers}>

                            <TouchableOpacity activeOpacity={1} onPress={toggleSummaryCard} style={styles.sheetHeader}>
                                <View style={styles.dragHandle} />
                                <Animated.Text style={[styles.summaryHeaderText, { position: 'absolute', top: 32, opacity: summaryTranslateY.interpolate({ inputRange: [0, SHEET_OFFSET], outputRange: [1, 0], extrapolate: 'clamp' }) }]}>
                                    Route Analysis
                                </Animated.Text>
                                <Animated.Text style={[styles.summaryHeaderText, { position: 'absolute', top: 32, color: '#0A84FF', opacity: summaryTranslateY.interpolate({ inputRange: [0, SHEET_OFFSET], outputRange: [0, 1], extrapolate: 'clamp' }) }]}>
                                    TAP OR PULL UP TO REVIEW
                                </Animated.Text>
                            </TouchableOpacity>

                            <View style={styles.sheetContent}>
                                <Text style={styles.summaryTitle}>Climb Graded</Text>

                                <View style={styles.statsRow}>
                                    <View style={styles.statBox}>
                                        <Text style={styles.statValue}>{routeStats.grade}</Text>
                                        <Text style={styles.statLabel}>Grade</Text>
                                    </View>
                                    <View style={styles.statBox}>
                                        <Text style={styles.statValue}>{routeStats.moves}</Text>
                                        <Text style={styles.statLabel}>Moves</Text>
                                    </View>
                                    <View style={styles.statBox}>
                                        <Text style={styles.statValue}>{routeStats.holds}</Text>
                                        <Text style={styles.statLabel}>Holds</Text>
                                    </View>
                                </View>

                                <TouchableOpacity activeOpacity={0.8} onPress={hardReset} style={styles.primaryActionBtn}>
                                    <Text style={styles.primaryActionBtnText}>Finish</Text>
                                </TouchableOpacity>
                            </View>
                            <View style={styles.bottomFillerBox} />
                        </Animated.View>
                    ) : (
                        <View style={styles.darkNavBar}>
                            <Animated.View style={[styles.navCenter, { opacity: navOpacity, transform: [{ translateX: navTranslateX }] }]} pointerEvents="none">
                                <Text style={styles.navMainTitle}>
                                    {step === 'START' ? "Starts (1/4)" : step === 'TOP' ? "Top Hold (2/4)" : step === 'ROUTE' ? "Path (3/4)" : "Review (4/4)"}
                                </Text>
                            </Animated.View>

                            <TouchableOpacity activeOpacity={0.6} onPress={step === 'START' ? hardReset : goBackStep} style={styles.navActionLeft}>
                                <Text style={styles.navSubText}>{step === 'START' ? "Cancel" : "Back"}</Text>
                            </TouchableOpacity>

                            <TouchableOpacity activeOpacity={0.8} onPress={goNextStep} style={styles.nextButton}>
                                <Text style={styles.nextButtonText}>{step === 'EDIT' ? "Analyze" : "Next"}</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <CameraView ref={cameraRef} style={styles.camera} facing="back" />

            <View style={styles.fintechCameraWrapper}>
                <BlurView intensity={70} tint="dark" style={styles.fintechCameraBar}>
                    <TouchableOpacity activeOpacity={0.7} style={styles.galleryBtn} onPress={pickImage}>
                        <Text style={styles.galleryBtnText}>Upload</Text>
                    </TouchableOpacity>

                    <TouchableOpacity activeOpacity={0.8} style={styles.fintechShutter} onPress={takePicture}>
                        <View style={styles.fintechShutterInner} />
                    </TouchableOpacity>

                    <View style={styles.galleryBtnInvisible} />
                </BlurView>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: 'black' },
    camera: { flex: 1 },
    imageContainer: { flex: 1, position: 'relative', overflow: 'hidden' },
    box: { position: 'absolute', borderRadius: 8 },

    loaderOverlay: { ...StyleSheet.absoluteFill, justifyContent: 'center', alignItems: 'center', zIndex: 50, backgroundColor: 'rgba(0,0,0,0.6)' },
    loadingTrack: { width: 120, height: 4, backgroundColor: '#2C2C2E', borderRadius: 2, overflow: 'hidden' },
    loadingIndicator: { width: 30, height: '100%', backgroundColor: '#0A84FF', borderRadius: 2, shadowColor: '#0A84FF', shadowOpacity: 0.8, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
    loadingText: { color: '#FFFFFF', marginTop: 20, fontSize: 12, fontWeight: '700', letterSpacing: 2.5, textTransform: 'uppercase', opacity: 0.9 },

    fintechCameraWrapper: { position: 'absolute', bottom: Platform.OS === 'ios' ? 50 : 30, width: '100%', alignItems: 'center' },
    fintechCameraBar: { width: '85%', height: 100, borderRadius: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
    fintechShutter: { width: 72, height: 72, borderRadius: 36, borderWidth: 3, borderColor: '#FFFFFF', justifyContent: 'center', alignItems: 'center' },
    fintechShutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#FFFFFF' },
    galleryBtn: { paddingVertical: 12, paddingHorizontal: 18, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 20 },
    galleryBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14, letterSpacing: 0.5 },
    galleryBtnInvisible: { width: 85, height: 10 },

    miniTag: { position: 'absolute', bottom: 4, right: 4, backgroundColor: '#1C1C1E', width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, justifyContent: 'center', alignItems: 'center', shadowColor: 'black', shadowOpacity: 0.5, shadowRadius: 3, shadowOffset: { width: 0, height: 2 } },
    miniTagText: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },

    popoverMenu: { position: 'absolute', width: 310, backgroundColor: '#1C1C1E', borderRadius: 24, padding: 16, borderWidth: 1, borderColor: '#2C2C2E', shadowColor: 'black', shadowOffset: {width:0, height: 12}, shadowOpacity: 0.6, shadowRadius: 24, elevation: 20 },
    gridContainer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
    gridButton: { width: '31%', backgroundColor: '#2C2C2E', paddingVertical: 16, borderRadius: 14, marginBottom: 10, alignItems: 'center' },
    gridButtonActive: { backgroundColor: '#0A84FF', shadowColor: '#0A84FF', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
    gridButtonText: { color: '#8E8E93', fontSize: 15, fontWeight: '600' },
    gridButtonTextActive: { color: '#FFFFFF', fontWeight: '800' },

    bottomOverlayContainer: { position: 'absolute', bottom: 0, width: '100%', zIndex: 100 },

    darkNavBar: {
        backgroundColor: '#1C1C1E',
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: Platform.OS === 'ios' ? 44 : 24,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderTopWidth: 1,
        borderTopColor: '#2C2C2E',
        shadowColor: 'black',
        shadowOpacity: 0.3,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: -5 }
    },
    navCenter: { position: 'absolute', left: 0, right: 0, top: 20, bottom: Platform.OS === 'ios' ? 44 : 24, alignItems: 'center', justifyContent: 'center', zIndex: 0 },
    navActionLeft: { paddingVertical: 12, paddingRight: 20, zIndex: 10 },
    navMainTitle: { fontSize: 17, fontWeight: '700', color: '#FFFFFF' },
    navSubText: { fontSize: 17, color: '#0A84FF', fontWeight: '600' },

    nextButton: { backgroundColor: '#0A84FF', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 20, minWidth: 90, justifyContent: 'center', alignItems: 'center', zIndex: 10, shadowColor: '#0A84FF', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
    nextButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },

    summaryCard: { position: 'absolute', bottom: 0, width: '100%', height: 360, backgroundColor: '#151516', borderTopLeftRadius: 32, borderTopRightRadius: 32, borderTopWidth: 1, borderTopColor: '#2C2C2E', shadowColor: 'black', shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: -8 } },
    sheetHeader: { height: 65, width: '100%', alignItems: 'center', paddingTop: 12, backgroundColor: 'transparent' },
    sheetContent: { height: 295, paddingHorizontal: 24, paddingBottom: Platform.OS === 'ios' ? 44 : 24 },

    bottomFillerBox: { position: 'absolute', top: 360, left: 0, right: 0, height: 400, backgroundColor: '#151516' },

    dragHandle: { width: 40, height: 6, backgroundColor: '#3A3A3C', borderRadius: 3 },
    summaryHeaderText: { fontSize: 13, color: '#8E8E93', fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase' },
    summaryTitle: { fontSize: 34, fontWeight: '800', color: '#FFFFFF', marginBottom: 28, textAlign: 'center' },

    statsRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 36 },
    statBox: { flex: 1, backgroundColor: '#202022', paddingVertical: 24, borderRadius: 20, alignItems: 'center', marginHorizontal: 6, borderWidth: 1, borderColor: '#2C2C2E' },
    statValue: { fontSize: 32, fontWeight: '800', color: '#FFFFFF', marginBottom: 4 },
    statLabel: { fontSize: 12, color: '#8E8E93', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.0 },

    primaryActionBtn: { backgroundColor: '#0A84FF', width: '100%', paddingVertical: 20, borderRadius: 20, alignItems: 'center', shadowColor: '#0A84FF', shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 5 } },
    primaryActionBtnText: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' }
});