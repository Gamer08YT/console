/*
 * The WebRTC data channel the pointer moves can take instead of the WebSocket.
 *
 * It is unordered and never resent: on a lossy link a lost packet costs one
 * move, where on the WebSocket's TCP every move behind a lost segment waits
 * for it. The video stream opens it (video/rtcStream.ts) and input/control.ts
 * sends plain moves on it while it is open. Buttons, the wheel and keys stay
 * on the WebSocket, and the device gives a move from here the buttons the
 * WebSocket last set, so a move that comes late cannot press or release one.
 */
let channel: RTCDataChannel | null = null;

export function setMoveChannel(dc: RTCDataChannel | null) {
  channel = dc;
}

/** Send @p data as a move; false when the channel is not there to take it. */
export function sendMove(data: Uint8Array): boolean {
  const dc = channel;
  /* A channel backing up is a link that is behind: drop the move, the next
     one says where the pointer is anyway. */
  if (!dc || dc.readyState !== "open") return false;
  if (dc.bufferedAmount < 1024) dc.send(data.buffer as ArrayBuffer);
  return true;
}
