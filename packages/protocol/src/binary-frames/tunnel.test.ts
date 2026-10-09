import { expect, test } from "vitest";
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  TunnelOpcode,
  TUNNEL_CHUNK_BYTES,
  TUNNEL_WINDOW_BYTES,
  type TunnelFrame,
} from "./tunnel.js";

test("round trips every tunnel message including byte views with an offset", () => {
  const frames: TunnelFrame[] = [
    { opcode: TunnelOpcode.Open, streamId: "id", workspaceId: "项目", port: 65535 },
    { opcode: TunnelOpcode.Opened, streamId: "id" },
    { opcode: TunnelOpcode.Data, streamId: "id", payload: new Uint8Array([0, 255, 128]) },
    { opcode: TunnelOpcode.Credit, streamId: "id", bytes: TUNNEL_WINDOW_BYTES },
    { opcode: TunnelOpcode.End, streamId: "id" },
    { opcode: TunnelOpcode.Close, streamId: "id", reason: 3 },
  ];
  for (const frame of frames) {
    const encoded = encodeTunnelFrame(frame);
    const buffer = new Uint8Array(encoded.length + 5);
    buffer.set(encoded, 5);
    expect(decodeTunnelFrame(buffer.subarray(5))).toEqual(frame);
  }
});

test("rejects invalid identifiers, ports, credit and excessive payloads", () => {
  expect(decodeTunnelFrame(new Uint8Array([TunnelOpcode.Open, 0, 0]))).toBe(null);
  expect(decodeTunnelFrame(new Uint8Array([TunnelOpcode.End, 1, 255]))).toBe(null);
  expect(decodeTunnelFrame(new Uint8Array([TunnelOpcode.Open, 1, 65, 0, 0, 65]))).toBe(null);
  expect(decodeTunnelFrame(new Uint8Array([TunnelOpcode.Credit, 1, 65, 255, 255, 255, 255]))).toBe(
    null,
  );
  expect(decodeTunnelFrame(new Uint8Array([TunnelOpcode.Opened, 1, 65, 0]))).toBe(null);
  expect(() =>
    encodeTunnelFrame({
      opcode: TunnelOpcode.Data,
      streamId: "id",
      payload: new Uint8Array(TUNNEL_CHUNK_BYTES + 1),
    }),
  ).toThrow(RangeError);
  expect(() =>
    encodeTunnelFrame({ opcode: TunnelOpcode.Credit, streamId: "id", bytes: 0 }),
  ).toThrow(RangeError);
});
