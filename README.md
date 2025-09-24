## Prerequisites:

1) Node 18+ (or 20+)

2) A running Morago backend exposing:
- STOMP endpoints: /ws (SockJS) and/or /ws-native (native)
# App mappings:
- /app/call.accept, /app/call.reject, /app/call.end
- /app/webrtc.offer, /app/webrtc.answer, /app/webrtc.ice

- User queues: /user/queue/call-notifications, /user/queue/webrtc-signals

Handshake principal set from JWT (via query param ?token=…) so /user/queue/** routes messages to the right user (see “Backend requirements” below).

## Start the app
1) run the following commands:
  npm i
  npm run dev
2) Open two tabs in browser. 
Tab A (caller) → paste a USER JWT (must have role ROLE_USER)
Tab B (callee) → paste a TRANSLATOR JWT (must have role ROLE_TRANSLATOR)|
To get tokens (use the valid credentials)
# USER token
curl -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"phone":"01012345678","password":"user-password"}'

# TRANSLATOR token
curl -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"phone":"01012345679","password":"translator-password"}'

3) Steps to test (two tabs)

Open two browser tabs to http://localhost:5173.
Tab A (USER):
Paste the USER JWT
Set me to your user id/phone
Set peer to the translator id/phone
Click Connect WS
Tab B (TRANSLATOR):
Paste the TRANSLATOR JWT
Set me to the translator id/phone
Set peer to the user id/phone
Click Connect WS
In Tab A, click Create Call
(Translator should receive INCOMING_CALL in the log.)
In Tab B, click Accept (or Reject)
(User should receive CALL_ACCEPTED / CALL_REJECTED.)
In Tab A, click Start WebRTC (send OFFER)
You should see:
OFFER/ANSWER exchange
ICE candidate exchange
pc.state = connected
DataChannel opens and sends a ping
Click End in either tab
Both should log CALL_ENDED.