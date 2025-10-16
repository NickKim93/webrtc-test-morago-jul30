import { useEffect, useMemo, useRef, useState } from "react";
import { Client } from "@stomp/stompjs";
import type { IMessage } from "@stomp/stompjs";
import SockJS from "sockjs-client";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "/").replace(/\/+$/, "");
const WS_URL: string | undefined = import.meta.env.VITE_WS_URL;
const WS_PATH: string = import.meta.env.VITE_WS_PATH ?? "/ws-native";

function makeClient(token: string) {
  const withToken = (u: string) => {
    const sep = u.includes("?") ? "&" : "?";
    return `${u}${sep}token=${encodeURIComponent(token)}`;
  };

  const cfg: Partial<Client> =
    WS_URL
      ? { brokerURL: withToken(WS_URL) }
      : WS_PATH === "/ws"
        ? { webSocketFactory: () => new SockJS(withToken(WS_PATH)) }
        : { webSocketFactory: () => new WebSocket(withToken(WS_PATH)) };

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

type TokenMeta = {
  sub?: string;
  tokenType?: string;
  exp?: number;
  expiresAt?: Date;
  expired: boolean;
};

function decodeToken(token: string): TokenMeta | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const data = JSON.parse(atob(padded));
    const exp = typeof data.exp === "number" ? data.exp : undefined;
    const expiresAt = exp ? new Date(exp * 1000) : undefined;
    const expired = expiresAt ? expiresAt.getTime() <= Date.now() : false;
    return {
      sub: data.sub ?? data.id ?? undefined,
      tokenType: data.token_type ?? data.tokenType ?? undefined,
      exp,
      expiresAt,
      expired,
    };
  } catch {
    return null;
  }
}

type SigMsg =
  | { type: "OFFER" | "ANSWER"; callId: string; fromUserId: string; toUserId: string; sdp: RTCSessionDescriptionInit }
  | { type: "ICE_CANDIDATE"; callId: string; fromUserId: string; toUserId: string; candidate: RTCIceCandidateInit }
  | { type: string; callId: string; [k: string]: unknown };

export default function WebRtcTest() {
  // basics
  const [token, setToken] = useState<string>(() => localStorage.getItem("token") ?? "");
  const [me, setMe] = useState<string>("");
  const [peerId, setPeerId] = useState<string>("");
  const [peerUsername, setPeerUsername] = useState<string>("");
  const [themeId, setThemeId] = useState<string>("1");
  const [callId, setCallId] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const stompRef = useRef<Client | null>(null);

  // WebRTC
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const hasRemoteRef = useRef(false);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  // logs
  const [log, setLog] = useState<string[]>([]);
  const logLine = (s: string) => setLog((list) => [...list, `[${new Date().toLocaleTimeString()}] ${s}`]);
  const tokenMeta = useMemo(() => decodeToken(token), [token]);

  // auto-fill me from JWT if present
  useEffect(() => {
    if (!me && tokenMeta?.sub) {
      setMe(String(tokenMeta.sub));
    }
  }, [me, tokenMeta]);

  // connect / disconnect
  const connect = () => {
    if (!token) {
      alert("Paste a JWT access token first (from /auth/login).");
      return;
    }
    if (tokenMeta?.expired) {
      logLine("Token appears expired; refresh it before connecting.");
      return;
    }
    if (!tokenMeta?.sub) {
      logLine("Token payload missing subject/username; backend may reject the WS handshake.");
    }
    const client = makeClient(token);
    stompRef.current = client;
    client.onConnect = () => {
      setConnected(true);
      logLine("STOMP connected");
      client.subscribe("/user/queue/call-notifications", onCallNotif);
      client.subscribe("/user/queue/webrtc-signals", onSignal);
    };
    client.onStompError = (frame) => logLine("STOMP error: " + (frame.headers["message"] ?? ""));
    client.onWebSocketClose = () => setConnected(false);
    client.activate();
  };

  const disconnect = () => {
    stompRef.current?.deactivate();
    stompRef.current = null;
    setConnected(false);
    logLine("Disconnected");
  };

  // publish helper
  const send = (dest: string, body: unknown) => {
    stompRef.current?.publish({
      destination: `/app${dest}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  // REST create call
  const createCall = async () => {
    if (!token) {
      alert("Need token");
      return;
    }
    if (!peerId) {
      alert("Set translatorId before creating a call");
      return;
    }
    const translatorId = Number(peerId);
    if (Number.isNaN(translatorId)) {
      alert("translatorId must be numeric");
      return;
    }
    const themeValue = Number(themeId);
    const payload: Record<string, unknown> = { translatorId };
    if (!Number.isNaN(themeValue)) {
      payload.themeId = themeValue;
    }

    const res = await fetch(`${API_BASE}/call/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      logLine(`createCall failed: ${res.status}`);
      return;
    }

    const data = await res.json();
    const id = data?.id ?? data?.callId ?? callId;
    if (id) {
      setCallId(String(id));
    }
    if (!peerUsername) {
      const recipient =
        data?.recipientId ??
        data?.recipientUsername ??
        data?.recipient?.username ??
        data?.recipient?.phoneNumber ??
        data?.translatorPhone;
      if (recipient) {
        setPeerUsername(String(recipient));
      }
    }
    logLine(`Call created: ${id}`);
    logLine("Translator should get INCOMING_CALL");
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
    const payload = safeParse(msg.body);
    if (!payload) return;
    if (payload.callId) setCallId(String(payload.callId));
    const other =
      payload.otherParticipant ??
      (payload.callerId === me ? payload.recipientId : payload.callerId) ??
      payload.callerId ??
      payload.recipientId;
    if (other && typeof other === "string") {
      setPeerUsername(other);
    }
    logLine(`CALL NOTIF: ${payload.type} ${payload.callId ?? ""}`);
  };

  const onSignal = async (msg: IMessage) => {
    const payload = safeParse<SigMsg>(msg.body);
    if (!payload || payload.callId !== callId) return;
    if (payload.type === "OFFER") {
      const pc = ensurePc();
      await pc.setRemoteDescription(payload.sdp);
      hasRemoteRef.current = true;
      await drainIce(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (!peerUsername) {
        logLine("Cannot reply with ANSWER because peer username is unknown.");
        return;
      }
      send("/webrtc.answer", {
        type: "ANSWER",
        callId,
        fromUserId: me,
        toUserId: peerUsername,
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
        try {
          await pc.addIceCandidate(payload.candidate);
        } catch (err) {
          logLine("addIce error " + err);
        }
      }
    }
  };

  // start WebRTC (caller)
  const startOffer = async () => {
    if (!callId) {
      logLine("Set callId before sending an OFFER.");
      return;
    }
    if (!peerUsername) {
      logLine("Set peer username (phone) before sending an OFFER.");
      return;
    }
    const pc = ensurePc(true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send("/webrtc.offer", {
      type: "OFFER",
      callId,
      fromUserId: me,
      toUserId: peerUsername,
      sdp: offer,
    });
    logLine("OFFER sent");
  };

  // create/get RTCPeerConnection
  function ensurePc(isCaller = false) {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection({ iceServers: [] });
    pcRef.current = pc;
    pc.onconnectionstatechange = () => logLine(`pc.state = ${pc.connectionState}`);
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      if (!peerUsername) {
        logLine("Skipping ICE send because peer username is unknown.");
        return;
      }
      send("/webrtc.ice", {
        type: "ICE_CANDIDATE",
        callId,
        fromUserId: me,
        toUserId: peerUsername,
        candidate: event.candidate.toJSON(),
      });
    };
    if (isCaller) {
      const dc = pc.createDataChannel("test");
      dcRef.current = dc;
      dc.onopen = () => {
        logLine("datachannel open (caller)");
        dc.send("ping-from-caller");
      };
      dc.onmessage = (ev) => logLine("caller got: " + ev.data);
    } else {
      pc.ondatachannel = (ev) => {
        dcRef.current = ev.channel;
        dcRef.current.onopen = () => logLine("datachannel open (callee)");
        dcRef.current.onmessage = (event) => logLine("callee got: " + event.data);
      };
    }
    return pc;
  }

  async function drainIce(pc: RTCPeerConnection) {
    const queue = pendingIceRef.current.splice(0);
    for (const candidate of queue) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        logLine("drain addIce error " + err);
      }
    }
  }

  function teardownPc() {
    try {
      dcRef.current?.close();
    } catch {
      // ignore
    }
    try {
      pcRef.current?.close();
    } catch {
      // ignore
    }
    dcRef.current = null;
    pcRef.current = null;
    hasRemoteRef.current = false;
    pendingIceRef.current = [];
  }

  function safeParse<T = unknown>(s?: string): T | null {
    try {
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  }

  // token convenience
  useEffect(() => {
    if (token) {
      localStorage.setItem("token", token);
    }
  }, [token]);

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, Arial" }}>
      <h2>Morago WebRTC Minimal Test</h2>

      <section style={{ display: "grid", gap: 8, maxWidth: 800 }}>
        <label>JWT token
          <input value={token} onChange={(e) => setToken(e.target.value)} style={{ width: "100%" }} />
        </label>
        {tokenMeta && (
          <div style={{ fontSize: 12, color: tokenMeta.expired ? "#c22" : "#555" }}>
            {[
              tokenMeta.tokenType ?? "access",
              tokenMeta.sub ? `sub: ${tokenMeta.sub}` : null,
              tokenMeta.expiresAt ? `exp: ${tokenMeta.expiresAt.toLocaleString()}` : null,
              tokenMeta.expired ? "expired" : null,
            ].filter(Boolean).join(" | ")}
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ flex: 1 }}>me (phone from token)
            <input value={me} onChange={(e) => setMe(e.target.value)} style={{ width: "100%" }} />
          </label>
          <label style={{ flex: 1 }}>peer username (phone)
            <input value={peerUsername} onChange={(e) => setPeerUsername(e.target.value)} style={{ width: "100%" }} />
          </label>
          <label style={{ flex: 1 }}>callId
            <input value={callId} onChange={(e) => setCallId(e.target.value)} style={{ width: "100%" }} />
          </label>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ flex: 1 }}>translatorId (numeric)
            <input value={peerId} onChange={(e) => setPeerId(e.target.value)} style={{ width: "100%" }} />
          </label>
          <label style={{ width: 140 }}>themeId
            <input value={themeId} onChange={(e) => setThemeId(e.target.value)} style={{ width: "100%" }} />
          </label>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {!connected
            ? <button onClick={connect}>Connect WS</button>
            : <button onClick={disconnect}>Disconnect WS</button>}
          <button onClick={createCall} disabled={!connected}>Create Call (user -&gt; translator)</button>
          <button onClick={accept} disabled={!connected || !callId}>Accept</button>
          <button onClick={reject} disabled={!connected || !callId}>Reject</button>
          <button onClick={startOffer} disabled={!connected || !callId}>Start WebRTC (send OFFER)</button>
          <button onClick={end} disabled={!connected || !callId}>End</button>
        </div>

        <pre style={{ background: "#111", color: "#0f0", padding: 12, height: 280, overflow: "auto" }}>
{log.join("\n")}
        </pre>
      </section>
    </div>
  );
}
