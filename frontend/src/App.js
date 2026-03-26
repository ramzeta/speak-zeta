import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

const API_BASE = window.location.origin;
const WS_BASE = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function preferOpusHighQuality(sdp) {
  return sdp.replace(/a=fmtp:111 /g, 'a=fmtp:111 maxaveragebitrate=64000;stereo=0;usedtx=1;');
}

// ── TTS notifications for join/leave ──
function speak(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'es-ES';
  u.rate = 1.1;
  u.volume = 0.7;
  window.speechSynthesis.speak(u);
}

function userColor(name) {
  const colors = ['#5865f2','#eb459e','#fee75c','#57f287','#ed4245','#f47b67','#e8a8ff','#45ddc0'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
}

// ── Settings persistence ──

function loadSettings() {
  try {
    const raw = localStorage.getItem('discord_algorito_settings');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveSettings(settings) {
  try { localStorage.setItem('discord_algorito_settings', JSON.stringify(settings)); } catch {}
}

const savedSettings = loadSettings();

function App() {
  const [username, setUsername] = useState(savedSettings.username || '');
  const [joined, setJoined] = useState(false);
  const [rooms, setRooms] = useState([]);
  const [currentRoom, setCurrentRoom] = useState('general');
  const [currentRoomType, setCurrentRoomType] = useState('text');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomType, setNewRoomType] = useState('text');
  const [showNewRoom, setShowNewRoom] = useState(false);

  // Voice state
  const [voiceRoom, setVoiceRoom] = useState(null);
  const [voicePeers, setVoicePeers] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [myVoiceId, setMyVoiceId] = useState(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [pingMs, setPingMs] = useState(null);

  // Screen share state
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [screenStream, setScreenStream] = useState(null);
  const [viewingScreen, setViewingScreen] = useState(null); // peerId of who we're watching

  // Audio settings (persisted)
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  const [audioDevices, setAudioDevices] = useState({ inputs: [], outputs: [] });
  const [selectedInput, setSelectedInput] = useState(savedSettings.selectedInput || '');
  const [selectedOutput, setSelectedOutput] = useState(savedSettings.selectedOutput || '');
  const [inputVolume, setInputVolume] = useState(savedSettings.inputVolume ?? 100);
  const [outputVolume, setOutputVolume] = useState(savedSettings.outputVolume ?? 100);
  const [inputSensitivity, setInputSensitivity] = useState(savedSettings.inputSensitivity ?? 15);
  const [noiseSuppression, setNoiseSuppression] = useState(savedSettings.noiseSuppression ?? true);
  const [echoCancellation, setEchoCancellation] = useState(savedSettings.echoCancellation ?? true);
  const [autoGainControl, setAutoGainControl] = useState(savedSettings.autoGainControl ?? true);
  const [voiceMode, setVoiceMode] = useState(savedSettings.voiceMode || 'vad');
  const [pttKey, setPttKey] = useState(savedSettings.pttKey || 'Space');
  const [pttActive, setPttActive] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const [peerVolumes, setPeerVolumes] = useState(savedSettings.peerVolumes || {});

  const ws = useRef(null);
  const voiceWs = useRef(null);
  const localStream = useRef(null);
  const peerConnections = useRef({});
  const screenPeerConnections = useRef({});
  const remoteAudios = useRef({});
  const remoteScreens = useRef({}); // peerId -> { video, audio }
  const screenStreamRef = useRef(null);
  const messagesEnd = useRef(null);
  const screenVideoRef = useRef(null);
  const analyserRef = useRef(null);
  const analyserIntervalRef = useRef(null);
  const gainNodeRef = useRef(null);
  const audioContextRef = useRef(null);
  const pingIntervalRef = useRef(null);
  const pttKeyRef = useRef(pttKey);
  const voiceModeRef = useRef(voiceMode);

  // Keep refs in sync
  useEffect(() => { pttKeyRef.current = pttKey; }, [pttKey]);
  useEffect(() => { voiceModeRef.current = voiceMode; }, [voiceMode]);

  // ── Persist settings on change ──
  useEffect(() => {
    saveSettings({
      username, selectedInput, selectedOutput, inputVolume, outputVolume,
      inputSensitivity, noiseSuppression, echoCancellation, autoGainControl,
      voiceMode, pttKey, peerVolumes,
    });
  }, [username, selectedInput, selectedOutput, inputVolume, outputVolume,
      inputSensitivity, noiseSuppression, echoCancellation, autoGainControl,
      voiceMode, pttKey, peerVolumes]);

  const scrollToBottom = () => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  };
  useEffect(() => { scrollToBottom(); }, [messages]);

  // ── Enumerate devices ──

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      const outputs = devices.filter(d => d.kind === 'audiooutput');
      setAudioDevices({ inputs, outputs });
      if (!selectedInput && inputs.length > 0) setSelectedInput(inputs[0].deviceId);
      if (!selectedOutput && outputs.length > 0) setSelectedOutput(outputs[0].deviceId);
    } catch (e) {}
  }, [selectedInput, selectedOutput]);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);

  // ── PTT ──

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (voiceModeRef.current !== 'ptt') return;
      if (e.code === pttKeyRef.current && !e.repeat) {
        setPttActive(true);
        if (localStream.current) localStream.current.getAudioTracks().forEach(t => { t.enabled = true; });
        if (voiceWs.current?.readyState === WebSocket.OPEN)
          voiceWs.current.send(JSON.stringify({ type: 'speaking', speaking: true }));
      }
    };
    const handleKeyUp = (e) => {
      if (voiceModeRef.current !== 'ptt') return;
      if (e.code === pttKeyRef.current) {
        setPttActive(false);
        if (localStream.current) localStream.current.getAudioTracks().forEach(t => { t.enabled = false; });
        if (voiceWs.current?.readyState === WebSocket.OPEN)
          voiceWs.current.send(JSON.stringify({ type: 'speaking', speaking: false }));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); };
  }, []);

  // ── Text room ──

  const connectToRoom = useCallback((room, user) => {
    if (ws.current) ws.current.close();
    fetch(`${API_BASE}/api/rooms/${encodeURIComponent(room)}/messages`)
      .then(r => r.json()).then(msgs => setMessages(Array.isArray(msgs) ? msgs : [])).catch(() => {});
    const socket = new WebSocket(`${WS_BASE}/ws/${encodeURIComponent(room)}/${encodeURIComponent(user)}`);
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'rooms_update') setRooms(data.rooms);
      else setMessages(prev => [...prev, data]);
    };
    ws.current = socket;
  }, []);

  // ── Voice peer connection ──

  const createPeerConnection = useCallback((peerId, peerUsername, isInitiator) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerConnections.current[peerId] = pc;

    if (localStream.current) {
      localStream.current.getTracks().forEach(track => pc.addTrack(track, localStream.current));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && voiceWs.current?.readyState === WebSocket.OPEN) {
        voiceWs.current.send(JSON.stringify({ type: 'ice_candidate', target: peerId, candidate: event.candidate }));
      }
    };

    pc.ontrack = (event) => {
      const audio = new Audio();
      audio.srcObject = event.streams[0];
      audio.autoplay = true;
      const vol = peerVolumes[peerId] ?? 100;
      audio.volume = Math.min(vol / 100, 1.0);
      if (selectedOutput && audio.setSinkId) audio.setSinkId(selectedOutput).catch(() => {});
      remoteAudios.current[peerId] = audio;
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') cleanupPeer(peerId);
    };

    if (isInitiator) {
      pc.createOffer().then(offer => {
        offer.sdp = preferOpusHighQuality(offer.sdp);
        pc.setLocalDescription(offer);
        if (voiceWs.current?.readyState === WebSocket.OPEN)
          voiceWs.current.send(JSON.stringify({ type: 'offer', target: peerId, offer }));
      });
    }
    return pc;
  }, [selectedOutput, peerVolumes]);

  const cleanupPeer = useCallback((peerId) => {
    if (peerConnections.current[peerId]) { peerConnections.current[peerId].close(); delete peerConnections.current[peerId]; }
    if (remoteAudios.current[peerId]) { remoteAudios.current[peerId].srcObject = null; delete remoteAudios.current[peerId]; }
    if (screenPeerConnections.current[peerId]) { screenPeerConnections.current[peerId].close(); delete screenPeerConnections.current[peerId]; }
    if (remoteScreens.current[peerId]) { delete remoteScreens.current[peerId]; }
  }, []);

  // ── Screen share peer connection ──

  const createScreenPeerConnection = useCallback((peerId, isInitiator, stream) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    screenPeerConnections.current[peerId] = pc;

    if (stream) {
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && voiceWs.current?.readyState === WebSocket.OPEN) {
        voiceWs.current.send(JSON.stringify({ type: 'screen_ice_candidate', target: peerId, candidate: event.candidate }));
      }
    };

    pc.ontrack = (event) => {
      const mediaStream = event.streams[0];
      remoteScreens.current[peerId] = mediaStream;
      setViewingScreen(peerId);
    };

    if (isInitiator && stream) {
      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        if (voiceWs.current?.readyState === WebSocket.OPEN)
          voiceWs.current.send(JSON.stringify({ type: 'screen_offer', target: peerId, offer }));
      });
    }

    return pc;
  }, []);

  // ── Audio analyser ──

  const setupAnalyser = useCallback((stream) => {
    if (analyserIntervalRef.current) clearInterval(analyserIntervalRef.current);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioContextRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    const gainNode = ctx.createGain();
    gainNode.gain.value = inputVolume / 100;
    gainNodeRef.current = gainNode;
    source.connect(gainNode);
    gainNode.connect(analyser);
    analyserRef.current = analyser;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let wasSpeaking = false;
    analyserIntervalRef.current = setInterval(() => {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const level = Math.min(100, Math.round(avg * 1.5));
      setInputLevel(level);
      if (voiceModeRef.current === 'vad') {
        const nowSpeaking = level > inputSensitivity;
        if (nowSpeaking !== wasSpeaking) {
          wasSpeaking = nowSpeaking;
          setIsSpeaking(nowSpeaking);
          if (voiceWs.current?.readyState === WebSocket.OPEN)
            voiceWs.current.send(JSON.stringify({ type: 'speaking', speaking: nowSpeaking }));
        }
      }
    }, 50);
  }, [inputVolume, inputSensitivity]);

  const startPing = useCallback(() => {
    if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    pingIntervalRef.current = setInterval(() => {
      if (voiceWs.current?.readyState === WebSocket.OPEN)
        voiceWs.current.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    }, 5000);
  }, []);

  // ── Join voice ──

  const joinVoiceRoom = useCallback(async (roomName) => {
    if (voiceWs.current) { voiceWs.current.close(); Object.keys(peerConnections.current).forEach(cleanupPeer); }
    if (localStream.current) { localStream.current.getTracks().forEach(t => t.stop()); }
    if (analyserIntervalRef.current) clearInterval(analyserIntervalRef.current);
    if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    stopScreenShare();

    try {
      localStream.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedInput ? { exact: selectedInput } : undefined,
          echoCancellation, noiseSuppression, autoGainControl,
          sampleRate: 48000, channelCount: 1,
        }, video: false,
      });
      await refreshDevices();
    } catch {
      alert('No se pudo acceder al microfono.');
      return;
    }

    if (voiceMode === 'ptt') localStream.current.getAudioTracks().forEach(t => { t.enabled = false; });

    setupAnalyser(localStream.current);
    setVoiceRoom(roomName);
    setIsMuted(false);
    setIsDeafened(false);
    setIsSpeaking(false);
    setPingMs(null);
    setIsScreenSharing(false);
    setViewingScreen(null);

    const socket = new WebSocket(`${WS_BASE}/ws/voice/${encodeURIComponent(roomName)}/${encodeURIComponent(username)}`);

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'rooms_update': setRooms(data.rooms); break;
        case 'voice_peers':
          setMyVoiceId(data.your_id);
          setVoicePeers(data.peers.map(p => ({ ...p, speaking: p.speaking || false })));
          data.peers.forEach(peer => createPeerConnection(peer.ws_id, peer.username, true));
          break;
        case 'voice_peer_joined':
          setVoicePeers(prev => [...prev, { ws_id: data.ws_id, username: data.username, muted: false, deafened: false, speaking: false, streaming: false }]);
          createPeerConnection(data.ws_id, data.username, false);
          if (screenStreamRef.current) {
            createScreenPeerConnection(data.ws_id, true, screenStreamRef.current);
          }
          speak(`${data.username} entro`);
          break;
        case 'voice_peer_left':
          speak(`${data.username} salio`);
          setVoicePeers(prev => prev.filter(p => p.ws_id !== data.ws_id));
          cleanupPeer(data.ws_id);
          if (viewingScreen === data.ws_id) setViewingScreen(null);
          break;
        case 'offer': {
          let pc = peerConnections.current[data.from_id];
          if (!pc) pc = createPeerConnection(data.from_id, data.from_username, false);
          pc.setRemoteDescription(new RTCSessionDescription(data.offer))
            .then(() => pc.createAnswer())
            .then(answer => {
              answer.sdp = preferOpusHighQuality(answer.sdp);
              pc.setLocalDescription(answer);
              if (voiceWs.current?.readyState === WebSocket.OPEN)
                voiceWs.current.send(JSON.stringify({ type: 'answer', target: data.from_id, answer }));
            });
          break;
        }
        case 'answer': {
          const pc = peerConnections.current[data.from_id];
          if (pc) pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          break;
        }
        case 'ice_candidate': {
          const pc = peerConnections.current[data.from_id];
          if (pc && data.candidate) pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
          break;
        }
        case 'peer_state_changed':
          setVoicePeers(prev => prev.map(p => p.ws_id === data.ws_id ? { ...p, muted: data.muted, deafened: data.deafened, streaming: data.streaming } : p));
          break;
        case 'peer_speaking':
          setVoicePeers(prev => prev.map(p => p.ws_id === data.ws_id ? { ...p, speaking: data.speaking } : p));
          break;
        case 'peer_screen_share':
          setVoicePeers(prev => prev.map(p => p.ws_id === data.ws_id ? { ...p, streaming: data.streaming } : p));
          if (!data.streaming && viewingScreen === data.ws_id) setViewingScreen(null);
          break;
        case 'screen_offer': {
          const spc = createScreenPeerConnection(data.from_id, false, null);
          spc.setRemoteDescription(new RTCSessionDescription(data.offer))
            .then(() => spc.createAnswer())
            .then(answer => {
              spc.setLocalDescription(answer);
              if (voiceWs.current?.readyState === WebSocket.OPEN)
                voiceWs.current.send(JSON.stringify({ type: 'screen_answer', target: data.from_id, answer }));
            });
          break;
        }
        case 'screen_answer': {
          const spc = screenPeerConnections.current[data.from_id];
          if (spc) spc.setRemoteDescription(new RTCSessionDescription(data.answer));
          break;
        }
        case 'screen_ice_candidate': {
          const spc = screenPeerConnections.current[data.from_id];
          if (spc && data.candidate) spc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
          break;
        }
        case 'pong': setPingMs(Date.now() - data.timestamp); break;
        case 'error': alert(data.message); break;
        default: break;
      }
    };

    socket.onclose = () => {
      setVoiceRoom(null); setVoicePeers([]);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    };

    voiceWs.current = socket;
    startPing();
  }, [username, selectedInput, echoCancellation, noiseSuppression, autoGainControl,
      voiceMode, createPeerConnection, createScreenPeerConnection, cleanupPeer, setupAnalyser, startPing, refreshDevices, viewingScreen]);

  // ── Screen sharing ──

  const startScreenShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });

      screenStreamRef.current = stream;
      setIsScreenSharing(true);
      setScreenStream(stream);

      // Notify server
      if (voiceWs.current?.readyState === WebSocket.OPEN)
        voiceWs.current.send(JSON.stringify({ type: 'screen_share_start' }));

      // Send screen to all existing peers
      for (const peer of voicePeers) {
        createScreenPeerConnection(peer.ws_id, true, stream);
      }

      // Handle user stopping share via browser UI
      stream.getVideoTracks()[0].onended = () => {
        stopScreenShare();
      };
    } catch {
      // User cancelled
    }
  }, [voicePeers, createScreenPeerConnection]);

  const stopScreenShare = useCallback(() => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
    }
    Object.keys(screenPeerConnections.current).forEach(peerId => {
      screenPeerConnections.current[peerId].close();
      delete screenPeerConnections.current[peerId];
    });
    setIsScreenSharing(false);
    setScreenStream(null);
    if (voiceWs.current?.readyState === WebSocket.OPEN)
      voiceWs.current.send(JSON.stringify({ type: 'screen_share_stop' }));
  }, []);

  const leaveVoiceRoom = useCallback(() => {
    stopScreenShare();
    if (voiceWs.current) voiceWs.current.close();
    voiceWs.current = null;
    Object.keys(peerConnections.current).forEach(cleanupPeer);
    if (localStream.current) { localStream.current.getTracks().forEach(t => t.stop()); localStream.current = null; }
    if (analyserIntervalRef.current) clearInterval(analyserIntervalRef.current);
    if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    if (audioContextRef.current) { audioContextRef.current.close().catch(() => {}); audioContextRef.current = null; }
    setVoiceRoom(null); setVoicePeers([]); setMyVoiceId(null);
    setIsSpeaking(false); setPingMs(null); setInputLevel(0);
    setViewingScreen(null);
  }, [cleanupPeer, stopScreenShare]);

  const toggleMute = useCallback(() => {
    if (!localStream.current) return;
    const m = !isMuted;
    localStream.current.getAudioTracks().forEach(t => { t.enabled = !m; });
    setIsMuted(m);
    if (m) setIsSpeaking(false);
    if (voiceWs.current?.readyState === WebSocket.OPEN)
      voiceWs.current.send(JSON.stringify({ type: 'mute_toggle', muted: m }));
  }, [isMuted]);

  const toggleDeafen = useCallback(() => {
    const d = !isDeafened;
    setIsDeafened(d);
    if (d) {
      setIsMuted(true); setIsSpeaking(false);
      if (localStream.current) localStream.current.getAudioTracks().forEach(t => { t.enabled = false; });
    } else {
      setIsMuted(false);
      if (localStream.current) localStream.current.getAudioTracks().forEach(t => { t.enabled = true; });
    }
    Object.values(remoteAudios.current).forEach(audio => { audio.muted = d; });
    if (voiceWs.current?.readyState === WebSocket.OPEN)
      voiceWs.current.send(JSON.stringify({ type: 'deafen_toggle', deafened: d }));
  }, [isDeafened]);

  // Attach remote screen stream to video element when viewingScreen changes
  useEffect(() => {
    if (viewingScreen && screenVideoRef.current && remoteScreens.current[viewingScreen]) {
      screenVideoRef.current.srcObject = remoteScreens.current[viewingScreen];
    } else if (!viewingScreen && screenVideoRef.current) {
      screenVideoRef.current.srcObject = null;
    }
  }, [viewingScreen]);

  useEffect(() => { if (gainNodeRef.current) gainNodeRef.current.gain.value = inputVolume / 100; }, [inputVolume]);
  useEffect(() => {
    Object.entries(remoteAudios.current).forEach(([pid, audio]) => {
      audio.volume = Math.min(((peerVolumes[pid] ?? 100) / 100) * (outputVolume / 100), 1.0);
    });
  }, [outputVolume, peerVolumes]);
  useEffect(() => {
    if (selectedOutput) Object.values(remoteAudios.current).forEach(a => { if (a.setSinkId) a.setSinkId(selectedOutput).catch(() => {}); });
  }, [selectedOutput]);

  const changeInputDevice = useCallback(async (deviceId) => {
    setSelectedInput(deviceId);
    if (!voiceRoom || !localStream.current) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation, noiseSuppression, autoGainControl, sampleRate: 48000, channelCount: 1 },
        video: false,
      });
      const newTrack = newStream.getAudioTracks()[0];
      Object.values(peerConnections.current).forEach(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
        if (sender) sender.replaceTrack(newTrack);
      });
      localStream.current.getAudioTracks().forEach(t => t.stop());
      localStream.current = newStream;
      setupAnalyser(newStream);
      if (voiceMode === 'ptt' && !pttActive) newStream.getAudioTracks().forEach(t => { t.enabled = false; });
      if (isMuted) newStream.getAudioTracks().forEach(t => { t.enabled = false; });
    } catch {}
  }, [voiceRoom, echoCancellation, noiseSuppression, autoGainControl, voiceMode, pttActive, isMuted, setupAnalyser]);

  const setPeerVolume = useCallback((peerId, vol) => {
    setPeerVolumes(prev => ({ ...prev, [peerId]: vol }));
    const audio = remoteAudios.current[peerId];
    if (audio) audio.volume = Math.min((vol / 100) * (outputVolume / 100), 1.0);
  }, [outputVolume]);

  // ── Handlers ──

  const handleJoin = (e) => {
    e.preventDefault();
    const name = username.trim().replace(/[^a-zA-Z0-9_\-]/g, '');
    if (!name) return;
    setUsername(name);
    setJoined(true);
    fetch(`${API_BASE}/api/rooms`).then(r => r.json()).then(setRooms).catch(() => {});
    connectToRoom(currentRoom, name);
  };

  const switchRoom = (roomName, roomType) => {
    setCurrentRoom(roomName);
    setCurrentRoomType(roomType);
    if (roomType === 'text') { setMessages([]); connectToRoom(roomName, username); }
  };

  const sendMessage = (e) => {
    e.preventDefault();
    const msg = input.trim().slice(0, 2000);
    if (!msg || !ws.current || ws.current.readyState !== WebSocket.OPEN) return;
    ws.current.send(msg);
    setInput('');
  };

  const createRoom = (e) => {
    e.preventDefault();
    if (!newRoomName.trim()) return;
    const name = newRoomName.toLowerCase().replace(/[^a-z0-9\-]/g, '').replace(/-+/g, '-').slice(0, 30);
    if (name.length < 2) return;
    fetch(`${API_BASE}/api/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: '', type: newRoomType }),
    }).then(r => r.json()).then(() => {
      setNewRoomName(''); setShowNewRoom(false);
      if (newRoomType === 'text') switchRoom(name, 'text');
      else joinVoiceRoom(name);
    }).catch(() => {});
  };

  // ── Render ──

  const textRooms = rooms.filter(r => r.type === 'text');
  const voiceRoomsList = rooms.filter(r => r.type === 'voice');
  const streamingPeer = voicePeers.find(p => p.streaming);

  if (!joined) {
    return (
      <div className="login-container">
        <div className="login-box">
          <h1>Discord Algorito</h1>
          <p>Entra con un nombre de usuario</p>
          <form onSubmit={handleJoin}>
            <input type="text" placeholder="Tu nombre (letras, numeros, - _)..." value={username}
              onChange={e => setUsername(e.target.value.replace(/[^a-zA-Z0-9_\-]/g, ''))} autoFocus maxLength={20} />
            <button type="submit" disabled={username.trim().length < 1}>Entrar</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="sidebar">
        <div className="sidebar-header">
          <h2>Discord Algorito</h2>
          <span className="user-badge">{username}</span>
        </div>

        <div className="rooms-header">
          <span>Salas de texto</span>
          <button className="add-room-btn" onClick={() => { setShowNewRoom(!showNewRoom); setNewRoomType('text'); }}>+</button>
        </div>
        <div className="rooms-list">
          {textRooms.map(room => (
            <div key={room.name} className={`room-item ${room.name === currentRoom && currentRoomType === 'text' ? 'active' : ''}`}
              onClick={() => switchRoom(room.name, 'text')}>
              <span className="room-name"># {room.name}</span>
              <span className="room-users">{room.user_count}</span>
            </div>
          ))}
        </div>

        <div className="rooms-header">
          <span>Salas de voz</span>
          <button className="add-room-btn" onClick={() => { setShowNewRoom(!showNewRoom); setNewRoomType('voice'); }}>+</button>
        </div>
        <div className="rooms-list voice-rooms-list">
          {voiceRoomsList.map(room => {
            const isInThisRoom = voiceRoom === room.name;
            return (
            <div key={room.name} className="voice-room-item">
              <div className={`room-item voice ${isInThisRoom ? 'active-voice' : ''}`}
                onClick={() => { switchRoom(room.name, 'voice'); if (!isInThisRoom) joinVoiceRoom(room.name); }}>
                <span className="room-name">
                  <svg className="voice-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 3a1 1 0 0 0-.707.293l-3 3A1 1 0 0 0 8 7v10a1 1 0 0 0 .293.707l3 3A1 1 0 0 0 13 20V4a1 1 0 0 0-1-1zM15.5 8.5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V9a.5.5 0 0 1 .5-.5zM18 7a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-1 0v-9A.5.5 0 0 1 18 7z"/></svg>
                  {room.name}
                </span>
                <span className="room-users">{room.user_limit > 0 ? `${room.user_count}/${room.user_limit}` : room.user_count}</span>
              </div>
              {room.users && room.users.length > 0 && (
                <div className="voice-users-list">
                  {room.users.map((u, i) => (
                    <div key={u.ws_id || i} className={`voice-user ${u.speaking ? 'is-speaking' : ''}`}>
                      <div className={`voice-avatar-small ${u.speaking ? 'speaking-ring' : ''}`} style={{ background: userColor(u.username) }}>
                        {u.username[0].toUpperCase()}
                      </div>
                      <span className="voice-user-name">{u.username}</span>
                      {u.streaming && <svg className="status-icon" viewBox="0 0 24 24" width="14" height="14" fill="#3ba55d"><path d="M2 4v13h8v3h4v-3h8V4H2zm18 11H4V6h16v9z"/></svg>}
                      {u.muted && <svg className="status-icon muted" viewBox="0 0 24 24" width="14" height="14" fill="#ed4245"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 1 0 6 0V5a3 3 0 0 0-3-3zM3.05 3.05a.75.75 0 0 1 1.06 0l16.84 16.84a.75.75 0 1 1-1.06 1.06L3.05 4.11a.75.75 0 0 1 0-1.06z"/></svg>}
                      {u.deafened && <svg className="status-icon deafened" viewBox="0 0 24 24" width="14" height="14" fill="#ed4245"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );})}
        </div>

        {showNewRoom && (
          <form onSubmit={createRoom} className="new-room-form">
            <div className="new-room-type-toggle">
              <button type="button" className={newRoomType === 'text' ? 'active' : ''} onClick={() => setNewRoomType('text')}>#</button>
              <button type="button" className={newRoomType === 'voice' ? 'active' : ''} onClick={() => setNewRoomType('voice')}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 3a1 1 0 0 0-.707.293l-3 3A1 1 0 0 0 8 7v10a1 1 0 0 0 .293.707l3 3A1 1 0 0 0 13 20V4a1 1 0 0 0-1-1z"/></svg>
              </button>
            </div>
            <input type="text" placeholder={`nombre-${newRoomType === 'voice' ? 'voz' : 'sala'}`}
              value={newRoomName} onChange={e => setNewRoomName(e.target.value)} autoFocus />
          </form>
        )}

        {voiceRoom && (
          <div className="voice-controls">
            <div className="voice-status">
              <span className="voice-connected-dot"></span>
              <div className="voice-status-text">
                <span className="voice-connected-label">Conectado por voz</span>
                <span className="voice-channel-name">{voiceRoom}</span>
              </div>
              {pingMs !== null && <span className={`voice-ping ${pingMs < 100 ? 'good' : pingMs < 200 ? 'ok' : 'bad'}`}>{pingMs}ms</span>}
            </div>
            <div className="voice-buttons">
              <button className={`vc-btn ${isMuted ? 'vc-active' : ''}`} onClick={toggleMute} title={isMuted ? 'Activar micro' : 'Silenciar'}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  {isMuted ? <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 1 0 6 0V5a3 3 0 0 0-3-3zM5 10a1 1 0 0 1 1 1 6 6 0 0 0 12 0 1 1 0 1 1 2 0 8 8 0 0 1-7 7.93V21a1 1 0 1 1-2 0v-2.07A8 8 0 0 1 4 11a1 1 0 0 1 1-1zM3.7 3.7a.75.75 0 0 1 1.06 0l15.54 15.54a.75.75 0 1 1-1.06 1.06L3.7 4.76a.75.75 0 0 1 0-1.06z"/>
                    : <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 1 0 6 0V5a3 3 0 0 0-3-3zM5 10a1 1 0 0 1 1 1 6 6 0 0 0 12 0 1 1 0 1 1 2 0 8 8 0 0 1-7 7.93V21a1 1 0 1 1-2 0v-2.07A8 8 0 0 1 4 11a1 1 0 0 1 1-1z"/>}
                </svg>
              </button>
              <button className={`vc-btn ${isDeafened ? 'vc-active' : ''}`} onClick={toggleDeafen} title={isDeafened ? 'Activar audio' : 'Ensordecer'}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  {isDeafened ? <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 13H8V9h2v6zm4 0h-2V9h2v6zM3.7 3.7a.75.75 0 0 1 1.06 0l15.54 15.54a.75.75 0 1 1-1.06 1.06L3.7 4.76a.75.75 0 0 1 0-1.06z"/>
                    : <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 13H8V9h2v6zm4 0h-2V9h2v6z"/>}
                </svg>
              </button>
              <button className={`vc-btn ${isScreenSharing ? 'vc-screen-active' : ''}`}
                onClick={() => isScreenSharing ? stopScreenShare() : startScreenShare()}
                title={isScreenSharing ? 'Dejar de compartir' : 'Compartir pantalla'}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M2 4v13h8v3h4v-3h8V4H2zm18 11H4V6h16v9z"/></svg>
              </button>
              <button className="vc-btn vc-settings" onClick={() => setShowVoiceSettings(!showVoiceSettings)} title="Ajustes de voz">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.26.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>
              </button>
              <button className="vc-btn vc-leave" onClick={leaveVoiceRoom} title="Desconectar">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.96.96 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71s-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.3 11.3 0 0 0-2.67-1.85.99.99 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="main">
        {showVoiceSettings && (
          <div className="settings-overlay" onClick={() => setShowVoiceSettings(false)}>
            <div className="settings-modal" onClick={e => e.stopPropagation()}>
              <div className="settings-header">
                <h3>Ajustes de voz</h3>
                <button className="settings-close" onClick={() => setShowVoiceSettings(false)}>
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
              </div>
              <div className="settings-body">
                <div className="settings-section">
                  <label className="settings-label">Dispositivo de entrada</label>
                  <select className="settings-select" value={selectedInput} onChange={e => changeInputDevice(e.target.value)}>
                    {audioDevices.inputs.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || `Micro ${d.deviceId.slice(0,5)}`}</option>)}
                  </select>
                </div>
                <div className="settings-section">
                  <label className="settings-label">Dispositivo de salida</label>
                  <select className="settings-select" value={selectedOutput} onChange={e => setSelectedOutput(e.target.value)}>
                    {audioDevices.outputs.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || `Altavoz ${d.deviceId.slice(0,5)}`}</option>)}
                  </select>
                </div>
                <div className="settings-section">
                  <label className="settings-label">Volumen de entrada<span className="settings-value">{inputVolume}%</span></label>
                  <input type="range" className="settings-range" min="0" max="200" value={inputVolume} onChange={e => setInputVolume(Number(e.target.value))} />
                  <div className="input-level-bar"><div className="input-level-fill" style={{ width: `${inputLevel}%` }}></div><div className="input-level-threshold" style={{ left: `${inputSensitivity}%` }}></div></div>
                </div>
                <div className="settings-section">
                  <label className="settings-label">Volumen de salida<span className="settings-value">{outputVolume}%</span></label>
                  <input type="range" className="settings-range" min="0" max="200" value={outputVolume} onChange={e => setOutputVolume(Number(e.target.value))} />
                </div>
                <div className="settings-section">
                  <label className="settings-label">Modo de entrada</label>
                  <div className="voice-mode-toggle">
                    <button className={voiceMode === 'vad' ? 'active' : ''} onClick={() => { setVoiceMode('vad'); if (localStream.current && !isMuted) localStream.current.getAudioTracks().forEach(t => { t.enabled = true; }); }}>Actividad de voz</button>
                    <button className={voiceMode === 'ptt' ? 'active' : ''} onClick={() => { setVoiceMode('ptt'); if (localStream.current) localStream.current.getAudioTracks().forEach(t => { t.enabled = false; }); }}>Pulsar para hablar</button>
                  </div>
                </div>
                {voiceMode === 'vad' && (
                  <div className="settings-section">
                    <label className="settings-label">Sensibilidad<span className="settings-value">{inputSensitivity}</span></label>
                    <input type="range" className="settings-range" min="1" max="80" value={inputSensitivity} onChange={e => setInputSensitivity(Number(e.target.value))} />
                    <div className="input-level-bar"><div className="input-level-fill" style={{ width: `${inputLevel}%` }}></div><div className="input-level-threshold" style={{ left: `${inputSensitivity}%` }}></div></div>
                  </div>
                )}
                {voiceMode === 'ptt' && (
                  <div className="settings-section">
                    <label className="settings-label">Tecla para hablar</label>
                    <button className="ptt-key-btn" onKeyDown={(e) => { e.preventDefault(); setPttKey(e.code); }} tabIndex={0}>{pttKey}</button>
                  </div>
                )}
                <div className="settings-section">
                  <label className="settings-label">Procesamiento de audio</label>
                  <div className="settings-toggles">
                    <label className="toggle-row"><span>Supresion de ruido</span><input type="checkbox" checked={noiseSuppression} onChange={e => setNoiseSuppression(e.target.checked)} /><span className="toggle-slider"></span></label>
                    <label className="toggle-row"><span>Cancelacion de eco</span><input type="checkbox" checked={echoCancellation} onChange={e => setEchoCancellation(e.target.checked)} /><span className="toggle-slider"></span></label>
                    <label className="toggle-row"><span>Control de ganancia</span><input type="checkbox" checked={autoGainControl} onChange={e => setAutoGainControl(e.target.checked)} /><span className="toggle-slider"></span></label>
                  </div>
                  <p className="settings-hint">Cambios se aplican al reconectar al canal.</p>
                </div>
                {voicePeers.length > 0 && (
                  <div className="settings-section">
                    <label className="settings-label">Volumen por usuario</label>
                    {voicePeers.map(peer => (
                      <div key={peer.ws_id} className="peer-volume-row">
                        <div className="peer-volume-avatar" style={{ background: userColor(peer.username) }}>{peer.username[0].toUpperCase()}</div>
                        <span className="peer-volume-name">{peer.username}</span>
                        <input type="range" className="settings-range peer-vol-range" min="0" max="200" value={peerVolumes[peer.ws_id] ?? 100} onChange={e => setPeerVolume(peer.ws_id, Number(e.target.value))} />
                        <span className="peer-volume-val">{peerVolumes[peer.ws_id] ?? 100}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {currentRoomType === 'text' ? (
          <>
            <div className="main-header"><h3># {currentRoom}</h3><span className="online-count">{rooms.find(r => r.name === currentRoom)?.user_count || 0} online</span></div>
            <div className="messages">
              {messages.map((msg, i) => msg.type === 'system' ? (
                <div key={i} className="system-msg">{msg.content}</div>
              ) : (
                <div key={i} className="message">
                  <div className="msg-avatar" style={{ background: userColor(msg.username) }}>{msg.username[0].toUpperCase()}</div>
                  <div className="msg-body">
                    <div className="msg-header"><span className="msg-user" style={{ color: userColor(msg.username) }}>{msg.username}</span><span className="msg-time">{new Date(msg.timestamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</span></div>
                    <div className="msg-content">{msg.content}</div>
                  </div>
                </div>
              ))}
              <div ref={messagesEnd} />
            </div>
            <div className="input-area">
              <form onSubmit={sendMessage}>
                <input type="text" placeholder={`Escribe un mensaje en #${currentRoom}`} value={input} onChange={e => setInput(e.target.value)} autoFocus maxLength={2000} />
                {input.trim() && <button type="submit">Enviar</button>}
              </form>
            </div>
          </>
        ) : (
          <div className="voice-main">
            <div className="main-header">
              <h3><svg className="voice-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 3a1 1 0 0 0-.707.293l-3 3A1 1 0 0 0 8 7v10a1 1 0 0 0 .293.707l3 3A1 1 0 0 0 13 20V4a1 1 0 0 0-1-1zM15.5 8.5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V9a.5.5 0 0 1 .5-.5zM18 7a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-1 0v-9A.5.5 0 0 1 18 7z"/></svg>{currentRoom}</h3>
              {/* Inline voice action buttons in header */}
              {voiceRoom === currentRoom && (
                <div className="voice-header-actions">
                  <button className={`vha-btn ${isScreenSharing ? 'active-green' : ''}`}
                    onClick={() => isScreenSharing ? stopScreenShare() : startScreenShare()}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M2 4v13h8v3h4v-3h8V4H2zm18 11H4V6h16v9z"/></svg>
                    {isScreenSharing ? 'Dejar de compartir' : 'Compartir pantalla'}
                  </button>
                </div>
              )}
            </div>

            {/* Banner: someone is sharing */}
            {voiceRoom === currentRoom && !viewingScreen && streamingPeer && (
              <div className="screen-share-banner" onClick={() => setViewingScreen(streamingPeer.ws_id)}>
                <div className="ssb-dot"></div>
                <span><strong>{streamingPeer.username}</strong> esta compartiendo pantalla</span>
                <button className="ssb-watch">Ver pantalla</button>
              </div>
            )}

            <div className={`voice-main-content ${viewingScreen ? 'has-screen' : ''}`}>
              {voiceRoom === currentRoom ? (
                <>
                  {/* Screen share viewer */}
                  {viewingScreen && (
                    <div className="screen-viewer">
                      <div className="screen-viewer-header">
                        <div className="screen-viewer-info">
                          <div className="ssb-dot"></div>
                          <span>Pantalla de <strong>{voicePeers.find(p => p.ws_id === viewingScreen)?.username || '...'}</strong></span>
                        </div>
                        <button className="screen-viewer-close" onClick={() => setViewingScreen(null)} title="Volver a la sala">
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                          <span>Cerrar</span>
                        </button>
                      </div>
                      <video ref={(el) => {
                        screenVideoRef.current = el;
                        if (el && viewingScreen && remoteScreens.current[viewingScreen]) {
                          el.srcObject = remoteScreens.current[viewingScreen];
                        }
                      }} autoPlay playsInline className="screen-video" />
                    </div>
                  )}

                  {/* Participants */}
                  <div className={viewingScreen ? 'voice-bar' : 'voice-grid'}>
                    <div className={`voice-tile ${viewingScreen ? 'mini' : ''} ${isSpeaking && !isMuted ? 'speaking' : ''}`}>
                      <div className={`voice-avatar ${isSpeaking && !isMuted ? 'speaking-ring' : ''}`} style={{ background: userColor(username) }}>{username[0].toUpperCase()}</div>
                      <span className="voice-tile-name">{username}</span>
                      <div className="voice-tile-icons">
                        {isScreenSharing && <svg className="tile-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M2 4v13h8v3h4v-3h8V4H2zm18 11H4V6h16v9z"/></svg>}
                        {isMuted && <svg className="tile-icon muted" viewBox="0 0 24 24" width="14" height="14" fill="#ed4245"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 1 0 6 0V5a3 3 0 0 0-3-3zM3.7 3.7a.75.75 0 0 1 1.06 0l15.54 15.54a.75.75 0 1 1-1.06 1.06L3.7 4.76a.75.75 0 0 1 0-1.06z"/></svg>}
                        {isDeafened && <svg className="tile-icon deafened" viewBox="0 0 24 24" width="14" height="14" fill="#ed4245"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>}
                      </div>
                      {!viewingScreen && voiceMode === 'ptt' && <div className={`ptt-indicator ${pttActive ? 'active' : ''}`}>{pttActive ? 'HABLANDO' : pttKey}</div>}
                    </div>
                    {voicePeers.map(peer => (
                      <div key={peer.ws_id}
                        className={`voice-tile ${viewingScreen ? 'mini' : ''} ${peer.speaking ? 'speaking' : ''} ${peer.streaming ? 'has-stream' : ''}`}
                        onClick={() => { if (peer.streaming && remoteScreens.current[peer.ws_id]) setViewingScreen(peer.ws_id); }}>
                        <div className={`voice-avatar ${peer.speaking ? 'speaking-ring' : ''}`} style={{ background: userColor(peer.username) }}>{peer.username[0].toUpperCase()}</div>
                        <span className="voice-tile-name">{peer.username}</span>
                        <div className="voice-tile-icons">
                          {peer.streaming && <svg className="tile-icon" viewBox="0 0 24 24" width="14" height="14" fill="var(--green)"><path d="M2 4v13h8v3h4v-3h8V4H2zm18 11H4V6h16v9z"/></svg>}
                          {peer.muted && <svg className="tile-icon muted" viewBox="0 0 24 24" width="14" height="14" fill="#ed4245"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 1 0 6 0V5a3 3 0 0 0-3-3zM3.7 3.7a.75.75 0 0 1 1.06 0l15.54 15.54a.75.75 0 1 1-1.06 1.06L3.7 4.76a.75.75 0 0 1 0-1.06z"/></svg>}
                          {peer.deafened && <svg className="tile-icon deafened" viewBox="0 0 24 24" width="14" height="14" fill="#ed4245"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>}
                        </div>
                        {!viewingScreen && peer.streaming && <div className="stream-label">EN VIVO</div>}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="voice-join-cta">
                  <div className="join-cta-icon">
                    <svg viewBox="0 0 24 24" width="56" height="56" fill="var(--brand)"><path d="M12 3a1 1 0 0 0-.707.293l-3 3A1 1 0 0 0 8 7v10a1 1 0 0 0 .293.707l3 3A1 1 0 0 0 13 20V4a1 1 0 0 0-1-1zM15.5 8.5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V9a.5.5 0 0 1 .5-.5zM18 7a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-1 0v-9A.5.5 0 0 1 18 7z"/></svg>
                  </div>
                  <h2 className="join-cta-title">{currentRoom}</h2>
                  <p className="join-cta-desc">
                    {voiceRoomsList.find(r => r.name === currentRoom)?.user_count > 0
                      ? `${voiceRoomsList.find(r => r.name === currentRoom).user_count} persona(s) en el canal`
                      : 'Nadie en el canal ahora mismo'}
                  </p>
                  <button className="join-cta-btn" onClick={() => joinVoiceRoom(currentRoom)}>
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 3a1 1 0 0 0-.707.293l-3 3A1 1 0 0 0 8 7v10a1 1 0 0 0 .293.707l3 3A1 1 0 0 0 13 20V4a1 1 0 0 0-1-1z"/></svg>
                    Unirse al canal de voz
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
