/**
 * 轻量级 MessagePack 解码器（纯 JavaScript 实现）
 *
 * 闲鱼 WebSocket 的 syncPushPackage.data 是 base64 编码的 MessagePack 二进制数据，
 * 不是 JSON。参考 XianyuAutoAgent 的 decrypt() 函数。
 *
 * MessagePack 规范: https://github.com/msgpack/msgpack/blob/master/spec.md
 */

export class MsgPackDecoder {
  private data: Uint8Array;
  private pos: number;

  constructor(data: Uint8Array) {
    this.data = data;
    this.pos = 0;
  }

  private readByte(): number {
    if (this.pos >= this.data.length) throw new Error('Unexpected end of data');
    return this.data[this.pos++];
  }

  private readBytes(count: number): Uint8Array {
    if (this.pos + count > this.data.length) throw new Error('Unexpected end of data');
    const result = this.data.slice(this.pos, this.pos + count);
    this.pos += count;
    return result;
  }

  private readUint8(): number { return this.readByte(); }

  private readUint16(): number {
    const b = this.readBytes(2);
    return (b[0] << 8) | b[1];
  }

  private readUint32(): number {
    const b = this.readBytes(4);
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }

  private readInt8(): number {
    const v = this.readByte();
    return v > 127 ? v - 256 : v;
  }

  private readInt16(): number {
    const v = this.readUint16();
    return v > 32767 ? v - 65536 : v;
  }

  private readInt32(): number {
    const v = this.readUint32();
    return v | 0; // convert to signed
  }

  private readFloat64(): number {
    const b = this.readBytes(8);
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    for (let i = 0; i < 8; i++) view.setUint8(i, b[i]);
    return view.getFloat64(0, false); // big-endian
  }

  private readFloat32(): number {
    const b = this.readBytes(4);
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    for (let i = 0; i < 4; i++) view.setUint8(i, b[i]);
    return view.getFloat32(0, false);
  }

  private readString(length: number): string {
    const bytes = this.readBytes(length);
    // TextDecoder for proper UTF-8
    return new TextDecoder('utf-8').decode(bytes);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private decodeArray(size: number): any[] {
    const result = [];
    for (let i = 0; i < size; i++) {
      result.push(this.decodeValue());
    }
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private decodeMap(size: number): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {};
    for (let i = 0; i < size; i++) {
      const key = this.decodeValue();
      const value = this.decodeValue();
      result[String(key)] = value;
    }
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decodeValue(): any {
    if (this.pos >= this.data.length) throw new Error('Unexpected end of data');
    const fmt = this.readByte();

    // Positive fixint (0xxxxxxx) -> 0x00-0x7f
    if (fmt <= 0x7f) return fmt;

    // Fixmap (1000xxxx) -> 0x80-0x8f
    if (fmt >= 0x80 && fmt <= 0x8f) return this.decodeMap(fmt & 0x0f);

    // Fixarray (1001xxxx) -> 0x90-0x9f
    if (fmt >= 0x90 && fmt <= 0x9f) return this.decodeArray(fmt & 0x0f);

    // Fixstr (101xxxxx) -> 0xa0-0xbf
    if (fmt >= 0xa0 && fmt <= 0xbf) return this.readString(fmt & 0x1f);

    // Negative fixint (111xxxxx) -> 0xe0-0xff
    if (fmt >= 0xe0) return fmt - 256;

    switch (fmt) {
      case 0xc0: return null;          // nil
      case 0xc2: return false;         // false
      case 0xc3: return true;          // true
      case 0xc4: return this.readBytes(this.readUint8());   // bin 8
      case 0xc5: return this.readBytes(this.readUint16());  // bin 16
      case 0xc6: return this.readBytes(this.readUint32());  // bin 32
      case 0xca: return this.readFloat32();  // float 32
      case 0xcb: return this.readFloat64();  // float 64
      case 0xcc: return this.readUint8();    // uint 8
      case 0xcd: return this.readUint16();   // uint 16
      case 0xce: return this.readUint32();   // uint 32
      case 0xcf: {
        // uint 64 - JS doesn't have native uint64, use two 32-bit reads
        const hi = this.readUint32();
        const lo = this.readUint32();
        return hi * 0x100000000 + lo;
      }
      case 0xd0: return this.readInt8();     // int 8
      case 0xd1: return this.readInt16();    // int 16
      case 0xd2: return this.readInt32();    // int 32
      case 0xd3: {
        // int 64
        const hi = this.readUint32();
        const lo = this.readUint32();
        const val = hi * 0x100000000 + lo;
        return hi & 0x80000000 ? val - 0x10000000000000000 : val;
      }
      case 0xd9: return this.readString(this.readUint8());   // str 8
      case 0xda: return this.readString(this.readUint16());  // str 16
      case 0xdb: return this.readString(this.readUint32());  // str 32
      case 0xdc: return this.decodeArray(this.readUint16()); // array 16
      case 0xdd: return this.decodeArray(this.readUint32()); // array 32
      case 0xde: return this.decodeMap(this.readUint16());   // map 16
      case 0xdf: return this.decodeMap(this.readUint32());   // map 32
      default:
        throw new Error(`Unknown MessagePack format: 0x${fmt.toString(16)}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decode(): any {
    return this.decodeValue();
  }
}

/**
 * 解码闲鱼 syncPushPackage 的 data 字段
 *
 * @param b64Data base64 编码的数据
 * @returns 解码后的对象（JSON 或 MessagePack），解码失败返回 null
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodeSyncData(b64Data: string): Record<string, any> | null {
  // 1. Base64 解码为 bytes
  const binaryStr = atob(b64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  // 2. 先尝试 JSON 解析
  // 注意：聊天消息和系统消息都可能是 JSON 格式，不能直接跳过！
  // 让调用方根据内容决定是否处理。
  try {
    const text = new TextDecoder('utf-8').decode(bytes);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    // JSON 解析失败 → 尝试 MessagePack 解码
  }

  // 3. MessagePack 解码
  try {
    const decoder = new MsgPackDecoder(bytes);
    const result = decoder.decode();
    return result as Record<string, unknown>;
  } catch (err) {
    console.log('[MsgPack] 解码失败:', err);
    return null;
  }
}
