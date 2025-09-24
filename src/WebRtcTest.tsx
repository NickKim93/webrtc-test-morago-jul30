import { useEffect, useRef, useState } from "react";
import { Client } from "@stomp/stompjs";
import type { IMessage } from "@stomp/stompjs"
import SockJS from "sockjs-client";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "/").replace(/\/+$/, "");
const WS_URL: string | undefined = import.meta.env.VITE_WS_URL;   // absolute ws(s)://.../ws-native
const WS_PATH: string = import.meta.env.VITE_WS_PATH ?? "/ws-native"; // relative path if proxied

function makeClient(token: string) {
  // Build a URL that includes ?token=... for the HTTP handshake (so Principal is set)
  const withToken = (u: string) => {
    const sep = u.includes("?") ? "&" : "?";
    return `${u}${sep}token=${encodeURIComponent(token)}`;
  };

  // Use brokerURL if WS_URL is absolute; otherwise create a factory (native or SockJS)
  const cfg: Partial<Client> =
    WS_URL
      ? { brokerURL: withToken(WS_URL) } // native ws absolute URL
      : WS_PATH === "/ws"                // SockJS relative path
        ? { webSocketFactory: () => new SockJS(withToken(WS_PATH)) }
        : { webSocketFactory: () => new WebSocket(withToken(WS_PATH)) }; // native ws relative

  const client = new Client({
    reconnectDelay: 5000,
    heartbeatIncoming: 10000,
    heartbeatOutgoing: 10000,
    // debug: (m) => console.log("[STOMP]", m),
    connectHeaders: token ? { Authorization: `Bearer ${token}` } : {},
    ...cfg,
  });

    return client;
}

type SigMsg =
  | { type: "OFFER" | "ANSWER"; callId: string; fromUserId: string; toUserId: string; sdp: RTCSessionDescriptionInit }
  | { type: "ICE_CANDIDATE"; callId: string; fromUserId: string; toUserId: string; candidate: RTCIceCandidateInit }
  | { type: string; callId: string; [k: string]: any };

export default function WebRtcTest() {
  // ——— basics
  const [token, setToken] = useState<string>(() => localStorage.getItem("token") ?? "");
  const [me, setMe] = useState<string>("");
  const [peer, setPeer] = useState<string>("");
  const [callId, setCallId] = useState<string>("local-test-1");
  const [connected, setConnected] = useState(false);
  const stompRef = useRef<Client | null>(null);

  // ——— WebRTC
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const hasRemoteRef = useRef(false);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  // ——— logs
  const [log, setLog] = useState<string[]>([]);
  const logLine = (s: string) => setLog((L) => [...L, `[${new Date().toLocaleTimeString()}] ${s}`]);

  // auto-fill me/peer from JWT if present
  useEffect(() => {
    try {
      const payload = token.split(".")[1];
      if (payload) {
        const obj = JSON.parse(atob(payload));
        // your JWT uses phone as sub; adjust if needed:
        if (!me) setMe(String(obj.sub ?? obj.id ?? ""));
      }
    } catch {}
  }, [token]);

  // connect / disconnect
  const connect = () => {
    if (!token) return alert("Paste a JWT token first (from /auth/login).");
    const c = makeClient(token);
    stompRef.current = c;
    c.onConnect = () => {
      setConnected(true);
      logLine("STOMP connected");
      // per-user queues
      c.subscribe("/user/queue/call-notifications", onCallNotif);
      c.subscribe("/user/queue/webrtc-signals", onSignal);
    };
    c.onStompError = (f) => logLine("STOMP error: " + (f.headers["message"] ?? ""));
    c.onWebSocketClose = () => setConnected(false);
    c.activate();
  };
  const disconnect = () => {
    stompRef.current?.deactivate();
    stompRef.current = null;
    setConnected(false);
    logLine("Disconnected");
  };

  // publish helper
  const send = (dest: string, body: any) => {
    stompRef.current?.publish({
      destination: `/app${dest}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  // REST create call
  const createCall = async () => {
    if (!token) return alert("Need token");
    const res = await fetch(`${API_BASE}/call/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ recipientId: Number(peer), themeId: 1 }), // <-- adjust for your IDs
    });
    if (!res.ok) return logLine(`createCall failed: ${res.status}`);
    const data = await res.json();
    const id = data?.id ?? data?.callId ?? callId;
    setCallId(String(id));
    logLine(`Call created: ${id}`);
    logLine(`Translator should get INCOMING_CALL`);
  };

  // accept / reject / end
  const accept = () => send("/call.accept", { callId });
  const reject = () => send("/call.reject", { callId, reason: "busy" });
  const end = () => {
    send("/call.end", { callId });
    teardownPc();
  };

  // signaling handlers
  const onCallNotif = (msg: IMessage) => {
    const m = safeParse(msg.body);
    logLine(`CALL NOTIF: ${m.type} ${m.callId ?? ""}`);
  };

  const onSignal = async (msg: IMessage) => {
    const payload: SigMsg = safeParse(msg.body);
    if (!payload || payload.callId !== callId) return;
    if (payload.type === "OFFER") {
      const pc = ensurePc();
      await pc.setRemoteDescription(payload.sdp);
      hasRemoteRef.current = true;
      await drainIce(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send("/webrtc.answer", {
        type: "ANSWER",
        callId,
        fromUserId: me,
        toUserId: peer,
        sdp: answer,
      });
      logLine("ANSWER sent");
    } else if (payload.type === "ANSWER") {
      const pc = ensurePc();
      await pc.setRemoteDescription(payload.sdp);
      hasRemoteRef.current = true;
      await drainIce(pc);
      logLine("ANSWER set");
    } else if (payload.type === "ICE_CANDIDATE") {
      const pc = ensurePc();
      if (!hasRemoteRef.current) {
        pendingIceRef.current.push(payload.candidate);
      } else {
        try { await pc.addIceCandidate(payload.candidate); } catch (e) { logLine("addIce error " + e); }
      }
    }
  };

  // start WebRTC (caller)
  const startOffer = async () => {
    const pc = ensurePc(true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send("/webrtc.offer", {
      type: "OFFER",
      callId,
      fromUserId: me,
      toUserId: peer,
      sdp: offer,
    });
    logLine("OFFER sent");
  };

  // create/get RTCPeerConnection
  function ensurePc(isCaller = false) {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection({ iceServers: [] }); // easiest for same-machine tests
    pcRef.current = pc;
    pc.onconnectionstatechange = () => logLine(`pc.state = ${pc.connectionState}`);
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      send("/webrtc.ice", {
        type: "ICE_CANDIDATE",
        callId,
        fromUserId: me,
        toUserId: peer,
        candidate: ev.candidate.toJSON(),
      });
    };
    if (isCaller) {
      const dc = pc.createDataChannel("test");
      dcRef.current = dc;
      dc.onopen = () => { logLine("datachannel open (caller)"); dc.send("ping-from-caller"); };
      dc.onmessage = (ev) => logLine("caller got: " + ev.data);
    } else {
      pc.ondatachannel = (e) => {
        dcRef.current = e.channel;
        dcRef.current.onopen = () => logLine("datachannel open (callee)");
        dcRef.current.onmessage = (ev) => logLine("callee got: " + ev.data);
      };
    }
    return pc;
  }

  async function drainIce(pc: RTCPeerConnection) {
    const q = pendingIceRef.current.splice(0);
    for (const c of q) {
      try { await pc.addIceCandidate(c); } catch (e) { logLine("drain addIce error " + e); }
    }
  }

  function teardownPc() {
    try { dcRef.current?.close(); } catch {}
    try { pcRef.current?.close(); } catch {}
    dcRef.current = null;
    pcRef.current = null;
    hasRemoteRef.current = false;
    pendingIceRef.current = [];
  }

  // simple JSON safe parse
  function safeParse(s?: string) {
    try { return s ? JSON.parse(s) : null; } catch { return null; }
  }

  // token convenience
  useEffect(() => { if (token) localStorage.setItem("token", token); }, [token]);

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, Arial" }}>
      <h2>Morago WebRTC Minimal Test</h2>

      <section style={{ display: "grid", gap: 8, maxWidth: 800 }}>
        <label>JWT token
          <input value={token} onChange={(e) => setToken(e.target.value)} style={{ width: "100%" }} />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ flex: 1 }}>me (userId/phone)
            <input value={me} onChange={(e) => setMe(e.target.value)} style={{ width: "100%" }} />
          </label>
          <label style={{ flex: 1 }}>peer (translatorId/phone)
            <input value={peer} onChange={(e) => setPeer(e.target.value)} style={{ width: "100%" }} />
          </label>
          <label style={{ flex: 1 }}>callId
            <input value={callId} onChange={(e) => setCallId(e.target.value)} style={{ width: "100%" }} />
          </label>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          {!connected
            ? <button onClick={connect}>Connect WS</button>
            : <button onClick={disconnect}>Disconnect WS</button>}
          <button onClick={createCall} disabled={!connected}>Create Call (user → translator)</button>
          <button onClick={accept} disabled={!connected}>Accept</button>
          <button onClick={reject} disabled={!connected}>Reject</button>
          <button onClick={startOffer} disabled={!connected}>Start WebRTC (send OFFER)</button>
          <button onClick={end} disabled={!connected}>End</button>
        </div>

        <pre style={{ background: "#111", color: "#0f0", padding: 12, height: 280, overflow: "auto" }}>
{log.join("\n")}
        </pre>
      </section>
    </div>
  );
}
