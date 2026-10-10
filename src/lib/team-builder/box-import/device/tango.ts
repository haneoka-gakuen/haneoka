/** Loaded on opening the import dialog, before the USB chooser's user gesture. */
import {
  Adb,
  AdbDaemonTransport,
  LinuxFileType,
  type AdbCredentialStore,
  type AdbPrivateKey,
  type AdbSync,
} from "@yume-chan/adb";
import {
  AdbDaemonWebUsbDeviceManager,
  AdbDaemonWebUsbDevice,
  type AdbDaemonWebUsbConnection,
} from "@yume-chan/adb-daemon-webusb";
import { BoxImportError } from "../types";
import type { DeviceReader, DeviceEntry } from "./reader";

export const usbAvailable = () => !!AdbDaemonWebUsbDeviceManager.BROWSER;
/** Fresh session keys, never persisted, shared, uploaded or logged. */
export function createUsbReader(): DeviceReader {
  let device: AdbDaemonWebUsbDevice | undefined;
  let connection: AdbDaemonWebUsbConnection | undefined;
  let adb: Adb | undefined, sync: AdbSync | undefined;
  let closed = false;
  const keys: AdbPrivateKey[] = [];
  const credentials: AdbCredentialStore = {
    iterateKeys: () => keys.values(),
    async generateKey() {
      const pair = await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
        true,
        ["sign", "verify"],
      );
      const buffer = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
      if (closed) {
        buffer.fill(0);
        throw new DOMException("Aborted", "AbortError");
      }
      const key = { buffer, name: "Haneoka import session" };
      keys.push(key);
      return key;
    },
  };
  const close = async () => {
    closed = true;
    keys.forEach((key) => key.buffer.fill(0));
    keys.length = 0;
    // Closing raw USB also interrupts authentication and stalled stream reads.
    await Promise.allSettled([
      device?.raw.close(),
      adb?.close(),
      connection && !connection.readable.locked ? connection.readable.cancel() : undefined,
      connection && !connection.writable.locked ? connection.writable.close() : undefined,
    ]);
    if (device?.raw.opened) throw new BoxImportError("device_close_failed");
  };
  const check = async (signal: AbortSignal) => {
    if (signal.aborted || closed) {
      await close();
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
  };
  const type = (value: number): DeviceEntry["type"] =>
    value === LinuxFileType.File ? "file" : value === LinuxFileType.Directory ? "directory" : "other";
  return {
    async open(signal) {
      const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
      if (!manager) throw new BoxImportError("device_unsupported");
      // No awaited module load before this chooser.
      device = await manager.requestDevice();
      if (!device) return false;
      await check(signal);
      try {
        connection = await device.connect();
        await check(signal);
      } catch (error) {
        await close();
        throw new BoxImportError(
          error instanceof AdbDaemonWebUsbDevice.DeviceBusyError ? "device_busy" : "device_connect_failed",
        );
      }
      try {
        adb = new Adb(
          await AdbDaemonTransport.authenticate({
            serial: "",
            connection,
            credentialStore: credentials,
            readTimeLimit: 10_000,
          }),
        );
        await check(signal);
        sync = await adb.sync();
        await check(signal);
        return true;
      } catch {
        await close();
        throw new BoxImportError("device_auth_failed");
      }
    },
    async type(path) {
      try {
        return type((await sync!.lstat(path)).type);
      } catch (error) {
        // Stable sync-v2 errno names, never expose arbitrary transport messages.
        if (error instanceof Error && ["EACCES", "EPERM"].includes(error.message))
          throw new BoxImportError("device_permission");
        if (error instanceof Error && ["ENOENT", "ENOTDIR"].includes(error.message))
          throw new BoxImportError("device_empty");
        throw new BoxImportError("device_read_failed");
      }
    },
    async *list(path) {
      for await (const entry of sync!.opendir(path)) yield { name: entry.name, type: type(entry.type) };
    },
    read: (path) => sync!.read(path).getReader(),
    close,
  };
}
