import {
  decodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "./file-transfer.js";
import {
  decodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from "./terminal.js";
import { decodeTunnelFrame, TunnelOpcode, type TunnelFrame } from "./tunnel.js";

export type BinaryFrame =
  | { kind: "tunnel"; frame: TunnelFrame }
  | { kind: "terminal"; frame: TerminalStreamFrame }
  | { kind: "file_transfer"; frame: FileTransferFrame };

export function decodeBinaryFrame(bytes: Uint8Array): BinaryFrame | null {
  switch (bytes[0]) {
    case TunnelOpcode.Open:
    case TunnelOpcode.Opened:
    case TunnelOpcode.Data:
    case TunnelOpcode.End:
    case TunnelOpcode.Close:
    case TunnelOpcode.Credit: {
      const frame = decodeTunnelFrame(bytes);
      return frame ? { kind: "tunnel", frame } : null;
    }
    case TerminalStreamOpcode.Output:
    case TerminalStreamOpcode.Input:
    case TerminalStreamOpcode.Resize:
    case TerminalStreamOpcode.Snapshot:
    case TerminalStreamOpcode.Restore: {
      const frame = decodeTerminalStreamFrame(bytes);
      return frame ? { kind: "terminal", frame } : null;
    }
    case FileTransferOpcode.FileBegin:
    case FileTransferOpcode.FileChunk:
    case FileTransferOpcode.FileEnd: {
      const frame = decodeFileTransferFrame(bytes);
      return frame ? { kind: "file_transfer", frame } : null;
    }
    default:
      return null;
  }
}
