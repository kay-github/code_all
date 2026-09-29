// 零依赖 ZIP 写入（仅 store 模式，无压缩）—— 用于生成 XLSX（也是合法 ZIP）。
// XLSX = OOXML 包 = 一个 ZIP（store 即可，Excel 完全兼容；仅文件略大，几百行可忽略）。
// 需要：TextEncoder（浏览器/Node 均内置）。不使用任何第三方库，保证单文件离线可用。

const encoder = new TextEncoder();

/** CRC-32（IEEE 802.3，反射多项式 0xEDB88320），查表法 */
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n: number): number[] { return [n & 0xff, (n >>> 8) & 0xff]; }
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** 将多个文件打包为 store 模式 ZIP 的字节数组 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const localParts: number[] = [];
  const centralParts: number[] = [];
  const offsets: number[] = [];

  for (const e of entries) {
    const nameBytes = encoder.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;
    offsets.push(localParts.length);

    // 本地文件头 (30 字节 + 文件名)
    localParts.push(0x50, 0x4b, 0x03, 0x04); // 签名
    localParts.push(...u16(20));   // version needed
    localParts.push(...u16(0x0800)); // 通用标志：bit11=UTF-8 文件名
    localParts.push(...u16(0));    // 压缩方法：store
    localParts.push(...u16(0));    // 修改时间
    localParts.push(...u16(0));    // 修改日期
    localParts.push(...u32(crc));  // CRC-32
    localParts.push(...u32(size)); // 压缩后大小
    localParts.push(...u32(size)); // 未压缩大小
    localParts.push(...u16(nameBytes.length));
    localParts.push(...u16(0));    // 额外字段长度
    for (const b of nameBytes) localParts.push(b);
    for (const b of e.data) localParts.push(b);

    // 中央目录头 (46 字节 + 文件名)
    centralParts.push(0x50, 0x4b, 0x01, 0x02); // 签名
    centralParts.push(...u16(20));  // version made by
    centralParts.push(...u16(20));  // version needed
    centralParts.push(...u16(0x0800));
    centralParts.push(...u16(0));   // 压缩方法
    centralParts.push(...u16(0));   // 时间
    centralParts.push(...u16(0));   // 日期
    centralParts.push(...u32(crc));
    centralParts.push(...u32(size));
    centralParts.push(...u32(size));
    centralParts.push(...u16(nameBytes.length));
    centralParts.push(...u16(0));   // 额外字段长度
    centralParts.push(...u16(0));   // 注释长度
    centralParts.push(...u16(0));   // 磁盘号
    centralParts.push(...u16(0));   // 内部属性
    centralParts.push(...u32(0));   // 外部属性
    centralParts.push(...u32(offsets[offsets.length - 1])); // 本地头偏移
    for (const b of nameBytes) centralParts.push(b);
  }

  const local = Uint8Array.from(localParts);
  const central = Uint8Array.from(centralParts);
  const cdOffset = local.length;
  const cdSize = central.length;

  // 结束中央目录 (22 字节)
  const end: number[] = [];
  end.push(0x50, 0x4b, 0x05, 0x06);
  end.push(...u16(0)); // 磁盘号
  end.push(...u16(0)); // 含中央目录的磁盘号
  end.push(...u16(entries.length)); // 本磁盘条目数
  end.push(...u16(entries.length)); // 总条目数
  end.push(...u32(cdSize));
  end.push(...u32(cdOffset));
  end.push(...u16(0)); // 注释长度
  const endBytes = Uint8Array.from(end);

  const total = local.length + central.length + endBytes.length;
  const out = new Uint8Array(total);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(endBytes, local.length + central.length);
  return out;
}
