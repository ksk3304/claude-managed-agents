/**
 * Unit tests for `src/lib/attachment-processing.ts` — image / PDF /
 * Office 添付処理 + ZIP-bomb 防御 (Cloud Run `cma_gchat_bot.py:2100-3040`
 * の TS port、Issue #186 既知 #1 + O)。
 *
 * テスト方針:
 *   - `isOfficeZipSafe` は zipSync で作った fixture / 大量 entry の synthetic
 *     ZIP を組み立てて entry-count / 1 entry size cap の両軸を検証する。
 *   - `extractDocxText` は zipSync で `<w:p><w:t>...</w:t></w:p>` を含む
 *     `word/document.xml` だけ詰めた minimal docx を作って検証。
 *   - `buildImageAttachments` / `buildPdfAttachments` は `fetch` を mock
 *     してネットワークを切り、inline path / unsupported skip / size over
 *     notice 経路を検証する。Anthropic client は使わない (= inline 経路の
 *     み叩く) のでダミーで OK。
 *   - `buildOfficeTextBlocks` は legacy MIME notice / 未対応 MIME silent skip
 *     経路を検証 (実 .pptx parsing は extractor 直接呼びでカバー)。
 */

import { describe, it, expect } from 'vitest';
import { strToU8, zipSync } from 'fflate';

import {
  buildImageAttachments,
  buildOfficeTextBlocks,
  buildPdfAttachments,
  extractDocxText,
  extractPptxText,
  extractXlsxText,
  isOfficeZipSafe,
  INLINE_VS_FILES_THRESHOLD_BYTES,
  MAX_OFFICE_UNCOMPRESSED_BYTES,
  type AttachmentDeps,
  type ChatAttachment,
} from '../src/lib/attachment-processing';
import { _resetChatTokenCacheForTests } from '../src/lib/chat-api';

// ============================================================================
// shared fixtures
// ============================================================================

/** dummy SA key — JWT 経路を avoid するため fetchImpl 側で token 交換 mock。 */
const FAKE_SA_KEY = JSON.stringify({
  client_email: 'fake-sa@fake.iam.gserviceaccount.com',
  // 1024-bit RSA private key (test only) — buildSaJwt が import するために
  // 形だけ valid PEM が必要。テスト中は fetchImpl が token を直接返すので
  // 実際の signing は走るが、生成された JWT は使われずに success token に
  // すり替わる。
  private_key:
    '-----BEGIN PRIVATE KEY-----\n' +
    'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7VJTUt9Us8cKj\n' +
    'MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu\n' +
    'NMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s+CLOyS56YyCFGeJZ\n' +
    'qgtzJ6GR3eqoYSW9b9UMvkBpZODSctWSNGj3P7jRFDO5VoTwCQAWbFnOjDfH5Ulg\n' +
    'p2PKSQnSJP3AJLQNFNe7br1XbrhV//eO+t51mIpGSDCUv3E0DDFcWDTH9cXDTTlR\n' +
    'ZVEiR2BwpZOOkE/Z0/BVnhZYL71oZV34bKfWjQIt6V/isSMahdsAASACp4ZTGtwi\n' +
    'VuNd9tybAgMBAAECggEBAKTmjaS6tkK8BlPXClTQ2vpz/N6uxDeS35mXpqasqskV\n' +
    'laAidgg/sWqpjXDbXr93otIMLlWsM+X0CqMDgSXKejLS2jx4GDjI1ZTXg++0AMJ8\n' +
    'sJ74pWzVDOfmCEQ/7wXs3+cbnXhKriO8Z036q92Qc1+N87SI38nkGa0ABH9CN83H\n' +
    'mQqt4fB7UdHzuIRe/me2PGhIq5ZBzj6h3BpoPGzEP+x3l9YmK8t/1cN0pqI+dQwY\n' +
    'dgfGjackLu/2qH80MCF7IyQaseZUOJyKrCLtSD/Iixv/hzDEUPfOCjFDgTpzf3cw\n' +
    'ta8+oE4wHCo1iI1/4TlPkwmXx4qSXtmw4aQPz7IDQvECgYEA8KNThCO2gsC2I9PQ\n' +
    'DM/8Cw0O983WCDY+oi+7JPiNAJwv5DYBqEZB1QYdj06YD16XlC/HAZMsMku1na2T\n' +
    'N0driwenQQWzoev3g2S7gRDoS/FCJSI3jJ+kjgtaA7Qmzlgk1TxODN+G1H91HW7t\n' +
    '0l7VnL27IWyYo2qRRK3jzxqUiPUCgYEAx0oQs2reBQGMVZnApD1jeq7n4MvNLcPv\n' +
    't8b/eU9iUv6Y4Mj0Suo/AU8lYZXm8ubbqAlwz2VSVunD2tOplHyMUrtCtObAfVDU\n' +
    'AhCndKaA9gApgfb3xw1IKbuQ1u4IF1FJl3VtumfQn//LiH1B3rXhcdyo3/vIttEk\n' +
    '48RakUKClU8CgYEAzV7W3COOlDDcQd935DdtKBFRAPRPAlspQUnzMi5eSHMD/ISL\n' +
    'DY5IiQHbIH83D4bvXq0X7qQoSBSNP7Dvv3HYuqMhf0DaegrlBuJllFVVq9qPVRnK\n' +
    'xt1Il2HgxOBvbhOT+9in1BzA+YJ99UzC85O0Qz06A+CmtHEy4aZ2kj5hHjECgYEA\n' +
    'mNS4+A8Fkss8Js1RieK2LniBxMgmYml3pfVLKGnzmng7H2+cwPLhPIzIuwytXywh\n' +
    '2bzbsYEfYx3EoEVgMEpPhoarQnYPukrJO4gwE2o5Te6T5mJSZGlQJQj9q4ZB2Dfz\n' +
    'et6INsK0oG8XVGXSpQvQh3RUYekCZQkBBFcpqWpbIEsCgYAnM3DQf3FJoSnXaMhr\n' +
    'VBIovic5l0xFkEHskAjFTevO86Fsz1C2aSeRKSqGFoOQ0tmJzBEs1R6KqnHInicD\n' +
    'TQrKhArgLXX4v3CddjfTRJkFWDbE/CkvKZNOrcf1nhaGCPspRJj2KUkj1Fhl9Cnc\n' +
    'dn/RsYEONbwQSjIfMPkvxF+8HQ==\n' +
    '-----END PRIVATE KEY-----',
});

/** Dummy Anthropic client — only `beta.files` is touched; for inline path
 * (= test 4-6) `upload` is never called. */
function makeFakeAnthropic(): any {
  return {
    beta: {
      files: {
        upload: async () => ({ id: 'file_fake' }),
        delete: async () => ({ id: 'file_fake', type: 'file_deleted' }),
      },
    },
  };
}

/** Make a fetchImpl that returns OAuth token + per-URL responses. */
function makeFetchMock(
  responses: Array<(url: string) => Response | Promise<Response>>,
): typeof fetch {
  let i = -1;
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    // token exchange path → 200 with a fake access_token
    if (url.includes('oauth2.googleapis.com')) {
      return new Response(
        JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    i += 1;
    if (i >= responses.length) {
      return new Response('no mock', { status: 500 });
    }
    return responses[i]!(url);
  }) as unknown as typeof fetch;
}

function depsWithFetch(fetchImpl: typeof fetch): AttachmentDeps {
  return {
    saKeyJson: FAKE_SA_KEY,
    anthropic: makeFakeAnthropic(),
    fetchImpl,
    sleep: async () => undefined,
    // test 環境では JWT signing path を avoid して固定 token を返す
    // (`getChatAccessToken` 経路はネット呼ばないため fake で完結する)。
    tokenProvider: async () => 'fake-token',
  };
}

// ============================================================================
// Test 1: isOfficeZipSafe accepts small valid zip
// ============================================================================

describe('isOfficeZipSafe', () => {
  it('accepts a small valid ZIP archive', () => {
    const zipBuf = zipSync({
      'word/document.xml': strToU8(
        '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>',
      ),
      '[Content_Types].xml': strToU8('<Types/>'),
    });
    const res = isOfficeZipSafe(zipBuf);
    expect(res.safe).toBe(true);
    expect(res.reason).toBe('');
  });

  // ============================================================================
  // Test 2: isOfficeZipSafe rejects ZIP with entry count exceeding cap
  // ============================================================================

  it('rejects a ZIP whose entry count exceeds MAX_OFFICE_ZIP_ENTRIES', () => {
    // 10_001 entries > MAX_OFFICE_ZIP_ENTRIES (= 10_000). 各 entry は 1 byte に
    // 抑えて total uncompressed が cap (= 500MB) を踏まないようにする。
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 10_001; i += 1) {
      files[`f${i}.txt`] = strToU8('x');
    }
    const zipBuf = zipSync(files);
    const res = isOfficeZipSafe(zipBuf);
    expect(res.safe).toBe(false);
    expect(res.reason).toMatch(/entry 数 10001/);
  });

  // ============================================================================
  // Test 2b (related): isOfficeZipSafe rejects ZIP whose uncompressed total
  // exceeds MAX_OFFICE_UNCOMPRESSED_BYTES. (Codex R1 防御の本丸)
  // ============================================================================

  it('rejects a ZIP whose uncompressed total exceeds MAX_OFFICE_UNCOMPRESSED_BYTES', () => {
    // 1 entry に MAX_OFFICE_UNCOMPRESSED_BYTES + 1 byte の payload を詰める。
    // 圧縮率を犠牲にしないため `level: 0` (store のみ) で zip し、CD の
    // uncompressed_size が cap 超を直接報告するようにする。実 ZIP bomb の
    // 検証はこれで十分 (= central directory inspect が落とす)。
    //
    // ただし fflate v0.8 は zipSync 内部で entire input をメモリに展開するため、
    // 500MB+1 を loop で書くのは Node test 環境では非実用的。代替として
    // 「fake CD を 1 entry 手作りで 0xFFFFFFFF size に詐称」する synthetic
    // ZIP を組み立て、cap 超過判定だけを test する。
    const cap = MAX_OFFICE_UNCOMPRESSED_BYTES;
    // 巨大ファイルを2件並べ、合算でcap超過させる
    const synthEntries = 2;
    const fakeUncompressed = Math.ceil((cap + 1) / synthEntries);
    const buf = synthesizeZipWithFakeSizes(synthEntries, fakeUncompressed);
    const res = isOfficeZipSafe(buf);
    expect(res.safe).toBe(false);
    expect(res.reason).toMatch(/uncompressed size 合計が上限/);
  });
});

// ============================================================================
// Test 3: extractDocxText pulls paragraph text and respects char_limit
// ============================================================================

describe('extractDocxText', () => {
  it('extracts paragraph text and applies char_limit truncation', () => {
    const xml =
      '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
      '<w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Third paragraph.</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const docx = zipSync({ 'word/document.xml': strToU8(xml) });
    const full = extractDocxText(docx, 1000);
    expect(full.truncated).toBe(false);
    expect(full.text).toBe('First paragraph.\nSecond paragraph.\nThird paragraph.');

    const trunc = extractDocxText(docx, 25);
    expect(trunc.truncated).toBe(true);
    expect(trunc.text.length).toBeLessThanOrEqual(25);
    expect(trunc.text.startsWith('First paragraph.')).toBe(true);
  });

  it('returns empty string when word/document.xml is absent', () => {
    const docx = zipSync({ 'other.xml': strToU8('<x/>') });
    const res = extractDocxText(docx, 100);
    expect(res.text).toBe('');
    expect(res.truncated).toBe(false);
  });
});

// ============================================================================
// Test 4: buildImageAttachments inline path (small image)
// ============================================================================

describe('buildImageAttachments', () => {
  it('returns base64 inline block for an image under the threshold', async () => {
    _resetChatTokenCacheForTests();
    const fakeImage = new Uint8Array(1024).fill(0x42); // 1KB の PNG dummy bytes
    const fetchImpl = makeFetchMock([
      () =>
        new Response(fakeImage, {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(fakeImage.byteLength),
          },
        }),
    ]);
    const attachments: ChatAttachment[] = [
      {
        contentType: 'image/png',
        contentName: 'cat.png',
        source: 'UPLOADED_CONTENT',
        attachmentDataRef: { resourceName: 'AAA' },
      },
    ];
    const res = await buildImageAttachments(depsWithFetch(fetchImpl), {
      attachment: attachments,
    });
    expect(res.blocks.length).toBe(1);
    expect(res.blocks[0]!.type).toBe('image');
    expect(res.blocks[0]!.source.type).toBe('base64');
    expect(res.notice).toBeNull();
    expect(res.uploadedFileIds).toEqual([]);
    // 1KB < threshold なので確実に inline 経路
    expect(fakeImage.byteLength).toBeLessThan(INLINE_VS_FILES_THRESHOLD_BYTES);
  });

  it('emits notice when an unsupported MIME (e.g. video) is present', async () => {
    _resetChatTokenCacheForTests();
    const attachments: ChatAttachment[] = [
      {
        contentType: 'video/mp4',
        contentName: 'clip.mp4',
        source: 'UPLOADED_CONTENT',
        attachmentDataRef: { resourceName: 'AAA' },
      },
    ];
    // fetch は呼ばれない (unsupported は download 前 skip)
    const fetchImpl = makeFetchMock([]);
    const res = await buildImageAttachments(depsWithFetch(fetchImpl), {
      attachment: attachments,
    });
    expect(res.blocks.length).toBe(0);
    expect(res.notice).toMatch(/画像\/PDF\/Office 以外のファイル 1 件/);
  });
});

// ============================================================================
// Test 5: buildPdfAttachments inline + skip-on-no-attachment
// ============================================================================

describe('buildPdfAttachments', () => {
  it('returns inline document block for a small PDF', async () => {
    _resetChatTokenCacheForTests();
    const fakePdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const fetchImpl = makeFetchMock([
      () =>
        new Response(fakePdf, {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': String(fakePdf.byteLength),
          },
        }),
    ]);
    const res = await buildPdfAttachments(depsWithFetch(fetchImpl), {
      attachment: [
        {
          contentType: 'application/pdf',
          contentName: 'doc.pdf',
          attachmentDataRef: { resourceName: 'BBB' },
        },
      ],
    });
    expect(res.blocks.length).toBe(1);
    expect(res.blocks[0]!.type).toBe('document');
    expect(res.blocks[0]!.source.type).toBe('base64');
    expect(res.notice).toBeNull();
  });

  it('returns empty result when message has no attachment field', async () => {
    _resetChatTokenCacheForTests();
    const fetchImpl = makeFetchMock([]);
    const res = await buildPdfAttachments(depsWithFetch(fetchImpl), {});
    expect(res.blocks.length).toBe(0);
    expect(res.notice).toBeNull();
    expect(res.uploadedFileIds).toEqual([]);
  });
});

// ============================================================================
// Test 6: buildOfficeTextBlocks notices for legacy MIME, silent skip unknown
// ============================================================================

describe('buildOfficeTextBlocks', () => {
  it('emits notice for legacy Office MIME (.ppt/.doc/.xls) and skips silently for unsupported', async () => {
    _resetChatTokenCacheForTests();
    const fetchImpl = makeFetchMock([]); // 何も download しない
    const res = await buildOfficeTextBlocks(depsWithFetch(fetchImpl), {
      attachment: [
        {
          contentType: 'application/vnd.ms-powerpoint',
          contentName: 'old.ppt',
          attachmentDataRef: { resourceName: 'CCC' },
        },
        {
          contentType: 'image/png', // 画像は別関数が処理 → notice には出ない
          contentName: 'pic.png',
          attachmentDataRef: { resourceName: 'DDD' },
        },
      ],
    });
    expect(res.blocks).toEqual([]);
    expect(res.notice).toMatch(/旧 Office 形式 \(\.ppt\/\.doc\/\.xls\) の 1 件/);
    // 画像 notice は混じらない (Office 関数の責務外)
    expect(res.notice).not.toMatch(/画像/);
  });

  it('extracts a real .pptx slide and returns a text block', async () => {
    _resetChatTokenCacheForTests();
    const slideXml =
      '<?xml version="1.0"?><p:sld xmlns:a="x" xmlns:p="y"><p:cSld><p:spTree>' +
      '<p:sp><p:txBody><a:p><a:r><a:t>Slide content</a:t></a:r></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld></p:sld>';
    const pptxBuf = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'ppt/slides/slide1.xml': strToU8(slideXml),
    });
    const fetchImpl = makeFetchMock([
      () =>
        new Response(pptxBuf, {
          status: 200,
          headers: {
            'Content-Type':
              'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'Content-Length': String(pptxBuf.byteLength),
          },
        }),
    ]);
    const res = await buildOfficeTextBlocks(depsWithFetch(fetchImpl), {
      attachment: [
        {
          contentType:
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          contentName: 'deck.pptx',
          attachmentDataRef: { resourceName: 'EEE' },
        },
      ],
    });
    expect(res.blocks.length).toBe(1);
    expect(res.blocks[0]!.type).toBe('text');
    expect(res.blocks[0]!.text).toContain('--- Slide 1 ---');
    expect(res.blocks[0]!.text).toContain('Slide content');
    expect(res.blocks[0]!.text).toContain('添付ファイル由来の未検証データ');
    expect(res.notice).toBeNull();
  });
});

// ============================================================================
// Test 7: extractXlsxText / extractPptxText sanity checks
// ============================================================================

describe('extractXlsxText', () => {
  it('extracts cells via sharedStrings + inline str', () => {
    const sharedStrings =
      '<?xml version="1.0"?><sst xmlns="x"><si><t>Hello</t></si><si><t>World</t></si></sst>';
    const sheet =
      '<?xml version="1.0"?><worksheet xmlns="x"><sheetData>' +
      '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>' +
      '<row><c t="inlineStr"><is><t>inline</t></is></c><c><v>42</v></c></row>' +
      '</sheetData></worksheet>';
    const workbook =
      '<?xml version="1.0"?><workbook xmlns="x"><sheets>' +
      '<sheet name="Greeting" sheetId="1" r:id="rId1"/>' +
      '</sheets></workbook>';
    const xlsx = zipSync({
      'xl/sharedStrings.xml': strToU8(sharedStrings),
      'xl/workbook.xml': strToU8(workbook),
      'xl/worksheets/sheet1.xml': strToU8(sheet),
    });
    const res = extractXlsxText(xlsx, 1000);
    expect(res.truncated).toBe(false);
    expect(res.text).toContain('--- Sheet: Greeting ---');
    expect(res.text).toContain('Hello\tWorld');
    expect(res.text).toContain('inline\t42');
  });
});

describe('extractPptxText', () => {
  it('extracts slide N text and notes when present', () => {
    const slide =
      '<?xml version="1.0"?><p:sld xmlns:a="x" xmlns:p="y"><p:cSld><p:spTree>' +
      '<p:sp><p:txBody><a:p><a:r><a:t>Main title</a:t></a:r></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld></p:sld>';
    const notes =
      '<?xml version="1.0"?><p:notes xmlns:a="x" xmlns:p="y"><p:cSld><p:spTree>' +
      '<p:sp><p:txBody><a:p><a:r><a:t>speaker note</a:t></a:r></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld></p:notes>';
    const pptxBuf = zipSync({
      'ppt/slides/slide1.xml': strToU8(slide),
      'ppt/notesSlides/notesSlide1.xml': strToU8(notes),
    });
    const res = extractPptxText(pptxBuf, 1000);
    expect(res.text).toContain('--- Slide 1 ---');
    expect(res.text).toContain('Main title');
    expect(res.text).toContain('[Notes] speaker note');
  });
});

// ============================================================================
// helper: synthesize a ZIP whose central directory records inflated
// uncompressed_size values (for ZIP-bomb cap tests without actually
// allocating gigabytes in the test process).
// ============================================================================

function synthesizeZipWithFakeSizes(
  entryCount: number,
  fakeUncompressed: number,
): Uint8Array {
  // Layout:
  //   per-entry local file header (no payload, since CD walking ignores it)
  //   central directory entries with crafted uncompressed_size
  //   EOCD
  //
  // We craft each local entry as: signature(4) + 26 bytes of zero-filled header
  // and filename `f{i}` (so the cd entry filename matches).
  const filenames = Array.from({ length: entryCount }, (_, i) => `f${i}`);
  // Local headers
  const locals: Uint8Array[] = [];
  for (const name of filenames) {
    const nameBytes = new TextEncoder().encode(name);
    const h = new Uint8Array(30 + nameBytes.length);
    h[0] = 0x50;
    h[1] = 0x4b;
    h[2] = 0x03;
    h[3] = 0x04;
    // filename length at offset 26 LE
    h[26] = nameBytes.length & 0xff;
    h[27] = (nameBytes.length >>> 8) & 0xff;
    h.set(nameBytes, 30);
    locals.push(h);
  }
  // Compute local file offsets
  const localOffsets: number[] = [];
  let p = 0;
  for (const h of locals) {
    localOffsets.push(p);
    p += h.length;
  }
  const localsConcat = concatU8(locals);

  // Central directory entries
  const cdEntries: Uint8Array[] = [];
  for (let i = 0; i < entryCount; i += 1) {
    const nameBytes = new TextEncoder().encode(filenames[i]!);
    const cd = new Uint8Array(46 + nameBytes.length);
    cd[0] = 0x50;
    cd[1] = 0x4b;
    cd[2] = 0x01;
    cd[3] = 0x02;
    // uncompressed_size at offset 24 LE (4 bytes)
    cd[24] = fakeUncompressed & 0xff;
    cd[25] = (fakeUncompressed >>> 8) & 0xff;
    cd[26] = (fakeUncompressed >>> 16) & 0xff;
    cd[27] = (fakeUncompressed >>> 24) & 0xff;
    // filename_length at offset 28 LE
    cd[28] = nameBytes.length & 0xff;
    cd[29] = (nameBytes.length >>> 8) & 0xff;
    // local header offset at 42 LE
    const off = localOffsets[i]!;
    cd[42] = off & 0xff;
    cd[43] = (off >>> 8) & 0xff;
    cd[44] = (off >>> 16) & 0xff;
    cd[45] = (off >>> 24) & 0xff;
    cd.set(nameBytes, 46);
    cdEntries.push(cd);
  }
  const cdConcat = concatU8(cdEntries);
  const cdOffset = localsConcat.length;
  const cdSize = cdConcat.length;

  // EOCD
  const eocd = new Uint8Array(22);
  eocd[0] = 0x50;
  eocd[1] = 0x4b;
  eocd[2] = 0x05;
  eocd[3] = 0x06;
  // entries on disk at 8 LE
  eocd[8] = entryCount & 0xff;
  eocd[9] = (entryCount >>> 8) & 0xff;
  // total entries at 10 LE
  eocd[10] = entryCount & 0xff;
  eocd[11] = (entryCount >>> 8) & 0xff;
  // cd size at 12 LE
  eocd[12] = cdSize & 0xff;
  eocd[13] = (cdSize >>> 8) & 0xff;
  eocd[14] = (cdSize >>> 16) & 0xff;
  eocd[15] = (cdSize >>> 24) & 0xff;
  // cd offset at 16 LE
  eocd[16] = cdOffset & 0xff;
  eocd[17] = (cdOffset >>> 8) & 0xff;
  eocd[18] = (cdOffset >>> 16) & 0xff;
  eocd[19] = (cdOffset >>> 24) & 0xff;

  return concatU8([localsConcat, cdConcat, eocd]);
}

function concatU8(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
