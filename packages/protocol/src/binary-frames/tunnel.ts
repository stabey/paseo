export const TunnelOpcode = {
  Data: 0x20,
  Close: 0x21,
  Open: 0x22,
  Opened: 0x23,
  End: 0x24,
  Credit: 0x25,
} as const;

export const TunnelCloseReason = {
  Closed: 0,
  Unavailable: 1,
  Forbidden: 2,
  ProtocolError: 3,
  LimitExceeded: 4,
} as const;

export const TUNNEL_CHUNK_BYTES = 64 * 1024;
export const TUNNEL_WINDOW_BYTES = 256 * 1024;
export const TUNNEL_STREAM_LIMIT = 64;

export type TunnelFrame =
  | { opcode: typeof TunnelOpcode.Open; streamId: string; workspaceId: string; port: number }
  | { opcode: typeof TunnelOpcode.Data; streamId: string; payload: Uint8Array }
  | { opcode: typeof TunnelOpcode.Credit; streamId: string; bytes: number }
  | { opcode: typeof TunnelOpcode.Close; streamId: string; reason: number }
  | { opcode: typeof TunnelOpcode.Opened | typeof TunnelOpcode.End; streamId: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeTunnelFrame(frame: TunnelFrame): Uint8Array {
  const id = encoder.encode(frame.streamId);
  if (id.length === 0 || id.length > 255) throw new RangeError("Invalid tunnel stream ID");
  let body: Uint8Array;
  switch (frame.opcode) {
    case TunnelOpcode.Open: {
      const workspace = encoder.encode(frame.workspaceId);
      if (!Number.isInteger(frame.port) || frame.port < 1 || frame.port > 65535) {
        throw new RangeError("Invalid tunnel port");
      }
      if (workspace.length === 0 || workspace.length > 1024) {
        throw new RangeError("Invalid tunnel workspace ID");
      }
      body = new Uint8Array(2 + workspace.length);
      new DataView(body.buffer).setUint16(0, frame.port);
      body.set(workspace, 2);
      break;
    }
    case TunnelOpcode.Data:
      if (frame.payload.length === 0 || frame.payload.length > TUNNEL_CHUNK_BYTES) {
        throw new RangeError("Invalid tunnel chunk size");
      }
      body = frame.payload;
      break;
    case TunnelOpcode.Credit:
      if (!Number.isInteger(frame.bytes) || frame.bytes < 1 || frame.bytes > TUNNEL_WINDOW_BYTES) {
        throw new RangeError("Invalid tunnel credit");
      }
      body = new Uint8Array(4);
      new DataView(body.buffer).setUint32(0, frame.bytes);
      break;
    case TunnelOpcode.Close:
      if (!Number.isInteger(frame.reason) || frame.reason < 0 || frame.reason > 255) {
        throw new RangeError("Invalid tunnel close reason");
      }
      body = new Uint8Array([frame.reason]);
      break;
    default:
      body = new Uint8Array();
  }
  const bytes = new Uint8Array(2 + id.length + body.length);
  bytes[0] = frame.opcode;
  bytes[1] = id.length;
  bytes.set(id, 2);
  bytes.set(body, 2 + id.length);
  return bytes;
}

function decodeOpenFrame(streamId: string, body: Uint8Array): TunnelFrame | null {
  if (body.length < 3 || body.length > 1026) return null;
  const port = new DataView(body.buffer, body.byteOffset, 2).getUint16(0);
  if (port === 0) return null;
  return {
    opcode: TunnelOpcode.Open,
    streamId,
    port,
    workspaceId: decoder.decode(body.subarray(2)),
  };
}

export function decodeTunnelFrame(bytes: Uint8Array): TunnelFrame | null {
  if (bytes[0] < TunnelOpcode.Data || bytes[0] > TunnelOpcode.Credit) return null;
  const idLength = bytes[1];
  if (bytes.length < 3 || idLength === 0 || idLength > bytes.length - 2) return null;
  try {
    const streamId = decoder.decode(bytes.subarray(2, 2 + idLength));
    const body = bytes.subarray(2 + idLength);
    const opcode = bytes[0];
    switch (opcode) {
      case TunnelOpcode.Open:
        return decodeOpenFrame(streamId, body);
      case TunnelOpcode.Data:
        return body.length > 0 && body.length <= TUNNEL_CHUNK_BYTES
          ? { opcode, streamId, payload: body }
          : null;
      case TunnelOpcode.Credit: {
        if (body.length !== 4) return null;
        const count = new DataView(body.buffer, body.byteOffset, 4).getUint32(0);
        return count > 0 && count <= TUNNEL_WINDOW_BYTES
          ? { opcode, streamId, bytes: count }
          : null;
      }
      case TunnelOpcode.Close:
        return body.length === 1 ? { opcode, streamId, reason: body[0] } : null;
      case TunnelOpcode.Opened:
      case TunnelOpcode.End:
        return body.length === 0 ? { opcode, streamId } : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
