/**
 * Unit tests for AgentMail read-only custom tool.
 */

import { describe, it, expect } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from '@zip.js/zip.js';
import { agentmailRead } from '../src/tools/agentmail-read';
import { makeFetchMock } from './makoto-helpers';

const DEPS = {
  apiKey: 'am-key',
  inboxId: 'inbox_main',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeDocx(text: string): Uint8Array {
  return zipSync({
    'word/document.xml': strToU8(
      '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
        `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>` +
        '</w:body></w:document>',
    ),
  });
}

function makeXlsx(values: string[]): Uint8Array {
  const sharedStrings = values
    .map((value) => `<si><t>${value}</t></si>`)
    .join('');
  const cells = values
    .map((_, idx) => `<c r="A${idx + 1}" t="s"><v>${idx}</v></c>`)
    .join('');
  return zipSync({
    'xl/sharedStrings.xml': strToU8(`<sst>${sharedStrings}</sst>`),
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="添付読取テスト"/></sheets></workbook>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData><row>${cells}</row></sheetData></worksheet>`),
  });
}

function markZipEncrypted(zip: Uint8Array): Uint8Array {
  const out = new Uint8Array(zip);
  for (let i = 0; i + 10 < out.length; i += 1) {
    const isLocalHeader =
      out[i] === 0x50 && out[i + 1] === 0x4b && out[i + 2] === 0x03 && out[i + 3] === 0x04;
    const isCentralHeader =
      out[i] === 0x50 && out[i + 1] === 0x4b && out[i + 2] === 0x01 && out[i + 3] === 0x02;
    if (isLocalHeader) out[i + 6] = out[i + 6]! | 0x01;
    if (isCentralHeader) out[i + 8] = out[i + 8]! | 0x01;
  }
  return out;
}

const ZIP_P_PASSWORD_GLAVIS0603_BASE64 =
  'UEsDBBQACQAIAElsyVyt7ci+BAQAAIYEAAAbABwAMzIyLXBhc3N3b3JkLXppcC1pbm5lci5kb2N4VVQJAAPJlydqyZcnanV4CwABBPUBAAAEAAAAAC+aJoxdvQejKmmV01PS+1J/yD7TcM2hA/WNLIwOF/Mzm8D6nhzsRr52BHzdjafRZPCgcmk9i+YT6nPDsbu9hUDRec707xzpfum8Abo9j8eSHMkgJjpRgNW11IwYj13F68AI04vVBA+PREL4Hvnt5QgtH0ie9Zvp0hZ5+Q4xxgX+qV9oqVj1R7awM7XZaDCQvzxStPQv3y4UK3gyiehWfw7gG/DcTkfPjH09I4aMiIGee4iezyjok9CDTokL6YcpadDzBsq7nWgJyn8MIQZ6xP4/qX4DVi5+CQHTS463zUJVu3K2WMT323zdBXDPyOz6f4DGRY+Md3q8a7AVj19wV1jcG2P6OUuwUpRwrWu0Pzi7FqRY95DSluPVUYyPzyo34m47FjHCB4Bfy7I1gPrV816yizU4425tv33qYz7uAl/NA7w7CwVZLbVoHv7bQwRrxth4WhoWDgHjFGiECk5FjhXrVzD95GWcnwPOOYF0LbJfyCZEfU2cIbHPJ/CmzjUCZ/PvP9YtJR986WU7mSpX+lA4McRyV0LteZqWoJ94SqphqCbNBD2a5ty2MHvL2+jSEhkpwlc7gIWsGAV8m/OrNbbXFlQ6kcnsOjCXZAWTj/jw6haDkAByNhFD1qxHjLDCS5c+5R+SkfWdUKLru2oATy2o0Uve7RZGX01VzOPtkhYxv6VesP+Yx+c0JAjsOF109WcLw4cElDYpUSFkpCZCcHfglCYrR4EXoBcBv/S2XH4mQCR43JKjE0uwVcRKYtXsOYlacy23pftaIyKQrB2lJeyMxSdDrG15o5kPvnve4jcY+fUbv+NfsODrJ0eWUOe+L7mB00qPDFxq637nXTgfln+4F+PEjxY7dO8/Co0QO+E2tg5RFvZeI03JGEPzuoUmivjQ3tPelh1TsZcD2p/bl3wUT+/kD01iHaj8tI2OvGWosZCHZDCqaJQuAz+V5H0+UQ7gTdmy5f096p0i59O8AGLhRCmvznRkaXkSCoZXrWTKlRH+VctqdVZo1+fD7QJOQvrFo1GRgBV6IFBJne4nFuAOjxiZsxDdwgcru4aTQZfxeMO1x57wJba5d9opkjcLElkopkWrxtAoWmZoTRGjIvFvaqty81wWEAsd/IHXBbkJKPdceAI8XrACda97l5mIGaBsda6AJaSvR2hZyWBKo+T5Swk6BMybG/PQj+zs+Ws2lqfwY6haAalI4gObCouy6Mdlka3MWH67OWcSdb2ztV3aoKbw/NogHfoSanN4ZUSladD1ONEZBLpXoeqnuOgQafPNpiBBesQBz0fxFhTdXupzPZHWtKI3iusPvLoLg7mTgQ14rb0sskg4+hXRaziSYlubRU312/pw6vDhqONRm4pVS8JbUEsHCK3tyL4EBAAAhgQAAFBLAQIeAxQACQAIAElsyVyt7ci+BAQAAIYEAAAbABgAAAAAAAAAAACkgQAAAAAzMjItcGFzc3dvcmQtemlwLWlubmVyLmRvY3hVVAUAA8mXJ2p1eAsAAQT1AQAABAAAAABQSwUGAAAAAAEAAQBhAAAAaQQAAAAA';

async function makeEncryptedZip(
  entries: Record<string, Uint8Array>,
  password: string,
): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    password,
    useWebWorkers: false,
  });
  for (const [name, data] of Object.entries(entries)) {
    await writer.add(name, new Uint8ArrayReader(data), {
      password,
      useWebWorkers: false,
    });
  }
  return await writer.close();
}

describe('agentmailRead search', () => {
  it('requires at least one selector', async () => {
    await expect(agentmailRead({ action: 'search' }, DEPS)).rejects.toThrow(
      /search requires at least one selector/,
    );
  });

  it('lists bounded message metadata without body', async () => {
    const fetcher = makeFetchMock(async (url, init) => {
      expect(init.method).toBe('GET');
      const parsed = new URL(url);
      expect(parsed.searchParams.get('limit')).toBe('10');
      expect(parsed.searchParams.get('after')).toBe('2026-06-01T00:00:00Z');
      expect(parsed.searchParams.get('include_spam')).toBe('true');
      return jsonResponse(200, {
        messages: [
          {
            id: 'msg_1',
            message_id: '<rfc1@example.com>',
            thread_id: 'thr_1',
            from: 'survey@example.com',
            to: ['makoto@example.com'],
            subject: 'アンケート回答',
            received_at: '2026-06-01T01:00:00Z',
            extracted_text: 'body must not leak from search',
          },
        ],
        next_page_token: 'next',
      });
    });
    const res = await agentmailRead(
      { action: 'search', after: '2026-06-01T00:00:00Z' },
      { ...DEPS, fetcher },
    );
    expect(res.count).toBe(1);
    expect(res.truncated).toBe(true);
    expect(res.next_page_token).toBe('next');
    const msg = (res.messages as Array<Record<string, unknown>>)[0];
    expect(msg.id).toBe('msg_1');
    expect(msg.body).toBeUndefined();
  });

  it('fills id from message_id when AgentMail list omits opaque id', async () => {
    const fetcher = makeFetchMock(async () =>
      jsonResponse(200, {
        messages: [
          {
            id: '',
            message_id: '<CAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg@mail.gmail.com>',
            thread_id: 'c7b5b833-bf1b-4d93-97d1-0bf572e866e7',
            subject: 'Fwd: 【初校】巻頭対談(河北新報：水野)',
            timestamp: '2026-06-04T03:23:49Z',
          },
        ],
      }),
    );
    const res = await agentmailRead(
      { action: 'search', subject_contains: '巻頭対談' },
      { ...DEPS, fetcher },
    );
    const msg = (res.messages as Array<Record<string, unknown>>)[0];
    expect(msg.id).toBe('<CAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg@mail.gmail.com>');
    expect(msg.message_id).toBe(
      '<CAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg@mail.gmail.com>',
    );
    expect(msg.thread_id).toBe('c7b5b833-bf1b-4d93-97d1-0bf572e866e7');
    expect(msg.received_at).toBe('2026-06-04T03:23:49Z');
  });

  it('allows callers to opt out of spam-inclusive search', async () => {
    const fetcher = makeFetchMock(async (url) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('include_spam')).toBeNull();
      return jsonResponse(200, { messages: [] });
    });
    const res = await agentmailRead(
      { action: 'search', after: '2026-06-01T00:00:00Z', include_spam: false },
      { ...DEPS, fetcher },
    );
    expect(res.count).toBe(0);
  });

  it('applies local from and subject filters', async () => {
    const fetcher = makeFetchMock(async () =>
      jsonResponse(200, {
        messages: [
          { id: 'a', from: 'alice@example.com', subject: 'アンケート回答' },
          { id: 'b', from: 'bob@example.com', subject: '別件' },
        ],
      }),
    );
    const res = await agentmailRead(
      { action: 'search', from_contains: 'alice', subject_contains: 'アンケート' },
      { ...DEPS, fetcher },
    );
    const messages = res.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m.id)).toEqual(['a']);
  });
});

describe('agentmailRead get', () => {
  it('fetches one message body with truncation and secret redaction', async () => {
    const fetcher = makeFetchMock(async (url, init) => {
      expect(init.method).toBe('GET');
      expect(url).toBe('https://api.agentmail.to/v0/inboxes/inbox_main/messages/msg_1');
      return jsonResponse(200, {
        id: 'msg_1',
        from: 'alice@example.com',
        subject: '回答',
        extracted_text: 'hello api_key=secret1234567890 tail',
        attachments: [{ filename: 'a.pdf', content_type: 'application/pdf', size: 12 }],
      });
    });
    const res = await agentmailRead(
      { action: 'get', message_id: 'msg_1', max_chars: 20 },
      { ...DEPS, fetcher },
    );
    const message = res.message as Record<string, unknown>;
    expect(message.body).toBe('hello api_key=[REDAC');
    expect(message.body_truncated).toBe(true);
    expect(message.attachments).toEqual([
      { filename: 'a.pdf', content_type: 'application/pdf', size: 12 },
    ]);
  });

  it('fetches and extracts Office attachment text by default on get', async () => {
    const docx = makeDocx('合言葉: ねこざめ-322-docx DOCX添付読取成功');
    const xlsx = makeXlsx(['合言葉', 'くじら雲-322-xlsx', 'XLSX添付読取成功']);
    const urls: string[] = [];
    const fetcher = makeFetchMock(async (url, init) => {
      expect(init.method).toBe('GET');
      urls.push(url);
      if (url.endsWith('/messages/msg_1')) {
        return jsonResponse(200, {
          id: 'msg_1',
          from: 'alice@example.com',
          subject: '添付確認',
          extracted_text: '本文には合言葉を書かない',
          attachments: [
            {
              attachment_id: 'att_docx',
              filename: 'agentmail-attachment-test-doc.docx',
              content_type:
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              size: docx.byteLength,
            },
            {
              attachment_id: 'att_xlsx',
              filename: 'agentmail-attachment-test-excel.xlsx',
              content_type:
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              size: xlsx.byteLength,
            },
          ],
        });
      }
      if (url.endsWith('/messages/msg_1/attachments/att_docx')) {
        return jsonResponse(200, {
          attachment_id: 'att_docx',
          download_url: 'https://agentmail-signed.test/download/att_docx',
        });
      }
      if (url.endsWith('/messages/msg_1/attachments/att_xlsx')) {
        return jsonResponse(200, {
          attachment_id: 'att_xlsx',
          download_url: 'https://agentmail-signed.test/download/att_xlsx',
        });
      }
      if (url === 'https://agentmail-signed.test/download/att_docx') {
        return new Response(docx, {
          status: 200,
          headers: {
            'content-type':
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          },
        });
      }
      if (url === 'https://agentmail-signed.test/download/att_xlsx') {
        return new Response(xlsx, {
          status: 200,
          headers: {
            'content-type':
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          },
        });
      }
      return new Response('unexpected', { status: 500 });
    });

    const res = await agentmailRead(
      { action: 'get', message_id: 'msg_1' },
      { ...DEPS, fetcher },
    );

    expect(urls).toEqual([
      'https://api.agentmail.to/v0/inboxes/inbox_main/messages/msg_1',
      'https://api.agentmail.to/v0/inboxes/inbox_main/messages/msg_1/attachments/att_docx',
      'https://agentmail-signed.test/download/att_docx',
      'https://api.agentmail.to/v0/inboxes/inbox_main/messages/msg_1/attachments/att_xlsx',
      'https://agentmail-signed.test/download/att_xlsx',
    ]);
    const message = res.message as Record<string, unknown>;
    const attachmentText = message.attachment_text as {
      items: Array<Record<string, unknown>>;
      notice: string | null;
    };
    expect(attachmentText.notice).toBeNull();
    const merged = attachmentText.items.map((item) => String(item.text ?? '')).join('\n');
    expect(merged).toContain('ねこざめ-322-docx');
    expect(merged).toContain('DOCX添付読取成功');
    expect(merged).toContain('くじら雲-322-xlsx');
    expect(merged).toContain('XLSX添付読取成功');
  });

  it('extracts Office files nested inside a ZIP attachment', async () => {
    const docx = makeDocx('ZIP内DOCX読取成功 らっこ-322-zip');
    const xlsx = makeXlsx(['ZIP内XLSX読取成功', 'いるか-322-zip']);
    const bundle = zipSync({
      'contracts/contract.docx': docx,
      'forms/account.xlsx': xlsx,
      'README.txt': strToU8('これは読取対象外'),
    });
    const fetcher = makeFetchMock(async (url) => {
      if (url.endsWith('/messages/msg_zip')) {
        return jsonResponse(200, {
          id: 'msg_zip',
          subject: 'ZIP添付確認',
          text: '本文',
          attachments: [
            {
              attachment_id: 'att_zip',
              filename: 'documents.zip',
              content_type: 'application/zip',
              size: bundle.byteLength,
            },
          ],
        });
      }
      if (url.endsWith('/messages/msg_zip/attachments/att_zip')) {
        return new Response(bundle, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      return new Response('unexpected', { status: 500 });
    });

    const res = await agentmailRead(
      { action: 'get', message_id: 'msg_zip' },
      { ...DEPS, fetcher },
    );

    const message = res.message as Record<string, unknown>;
    const attachmentText = message.attachment_text as {
      items: Array<Record<string, unknown>>;
      notice: string | null;
    };
    expect(attachmentText.notice).toBeNull();
    expect(attachmentText.items.map((item) => item.filename)).toEqual([
      'documents.zip/contracts/contract.docx',
      'documents.zip/forms/account.xlsx',
    ]);
    const merged = attachmentText.items.map((item) => String(item.text ?? '')).join('\n');
    expect(merged).toContain('ZIP内DOCX読取成功');
    expect(merged).toContain('らっこ-322-zip');
    expect(merged).toContain('ZIP内XLSX読取成功');
    expect(merged).toContain('いるか-322-zip');
  });

  it('reports encrypted ZIP attachments instead of treating them as unsafe Office ZIPs', async () => {
    const encryptedZip = markZipEncrypted(zipSync({ 'contract.docx': makeDocx('読めない') }));
    const fetcher = makeFetchMock(async (url) => {
      if (url.endsWith('/messages/msg_encrypted_zip')) {
        return jsonResponse(200, {
          id: 'msg_encrypted_zip',
          subject: 'PW付きZIP',
          text: 'パスワードは別送です',
          attachments: [
            {
              attachment_id: 'att_zip',
              filename: 'password-protected.zip',
              content_type: 'application/zip',
              size: encryptedZip.byteLength,
            },
          ],
        });
      }
      if (url.endsWith('/messages/msg_encrypted_zip/attachments/att_zip')) {
        return new Response(encryptedZip, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      return new Response('unexpected', { status: 500 });
    });

    const res = await agentmailRead(
      { action: 'get', message_id: 'msg_encrypted_zip' },
      { ...DEPS, fetcher },
    );

    const message = res.message as Record<string, unknown>;
    const attachmentText = message.attachment_text as {
      items: Array<Record<string, unknown>>;
      notice: string | null;
    };
    expect(attachmentText.items).toEqual([]);
    expect(attachmentText.notice).toContain('パスワード付きまたは暗号化ZIP 1 件は未対応です');
  });

  it('uses a password found in the mail body to extract encrypted ZIP Office files', async () => {
    const encryptedZip = await makeEncryptedZip(
      { 'contract.docx': makeDocx('PW付きZIP内DOCX読取成功 ぺんぎん-322-pwzip') },
      'glavis0603',
    );
    const fetcher = makeFetchMock(async (url) => {
      if (url.endsWith('/messages/msg_pw_zip')) {
        return jsonResponse(200, {
          id: 'msg_pw_zip',
          subject: 'PW付きZIP',
          text: '添付ZIPをご確認ください。パスワード: glavis0603',
          attachments: [
            {
              attachment_id: 'att_zip',
              filename: 'password-protected.zip',
              content_type: 'application/zip',
              size: encryptedZip.byteLength,
            },
          ],
        });
      }
      if (url.endsWith('/messages/msg_pw_zip/attachments/att_zip')) {
        return new Response(encryptedZip, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      return new Response('unexpected', { status: 500 });
    });

    const res = await agentmailRead(
      { action: 'get', message_id: 'msg_pw_zip' },
      { ...DEPS, fetcher },
    );

    const message = res.message as Record<string, unknown>;
    expect(String(message.body)).toContain('パスワード: [REDACTED_SECRET]');
    const attachmentText = message.attachment_text as {
      items: Array<Record<string, unknown>>;
      notice: string | null;
    };
    expect(attachmentText.notice).toBeNull();
    expect(attachmentText.items[0]?.filename).toBe('password-protected.zip/contract.docx');
    expect(String(attachmentText.items[0]?.text)).toContain('PW付きZIP内DOCX読取成功');
    expect(String(attachmentText.items[0]?.text)).toContain('ぺんぎん-322-pwzip');
  });

  it('uses an explicit zip_passwords argument to extract encrypted ZIP Office files', async () => {
    const encryptedZip = await makeEncryptedZip(
      { 'contract.docx': makeDocx('Chat指示PWでZIP内DOCX読取成功 きりん-322-pwarg') },
      'glavis0603',
    );
    const fetcher = makeFetchMock(async (url) => {
      if (url.endsWith('/messages/msg_pw_arg')) {
        return jsonResponse(200, {
          id: 'msg_pw_arg',
          subject: 'PW付きZIP',
          text: '添付ZIPをご確認ください。',
          attachments: [
            {
              attachment_id: 'att_zip',
              filename: 'password-protected.zip',
              content_type: 'application/zip',
              size: encryptedZip.byteLength,
            },
          ],
        });
      }
      if (url.endsWith('/messages/msg_pw_arg/attachments/att_zip')) {
        return new Response(encryptedZip, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      return new Response('unexpected', { status: 500 });
    });

    const res = await agentmailRead(
      { action: 'get', message_id: 'msg_pw_arg', zip_passwords: ['glavis0603'] },
      { ...DEPS, fetcher },
    );

    const message = res.message as Record<string, unknown>;
    const attachmentText = message.attachment_text as {
      items: Array<Record<string, unknown>>;
      notice: string | null;
    };
    expect(attachmentText.notice).toBeNull();
    expect(String(attachmentText.items[0]?.text)).toContain('きりん-322-pwarg');
  });

  it('uses a password candidate embedded in the ZIP filename for a zip -P fixture', async () => {
    const encryptedZip = Uint8Array.from(
      Buffer.from(ZIP_P_PASSWORD_GLAVIS0603_BASE64, 'base64'),
    );
    const fetcher = makeFetchMock(async (url) => {
      if (url.endsWith('/messages/msg_pw_filename')) {
        return jsonResponse(200, {
          id: 'msg_pw_filename',
          subject: 'PW付きZIP',
          text: '添付ZIPをご確認ください。',
          attachments: [
            {
              attachment_id: 'att_zip',
              filename: '322-password-office-files-password-glavis0603.zip',
              content_type: 'application/zip',
              size: encryptedZip.byteLength,
            },
          ],
        });
      }
      if (url.endsWith('/messages/msg_pw_filename/attachments/att_zip')) {
        return new Response(encryptedZip, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      return new Response('unexpected', { status: 500 });
    });

    const res = await agentmailRead(
      { action: 'get', message_id: 'msg_pw_filename' },
      { ...DEPS, fetcher },
    );

    const message = res.message as Record<string, unknown>;
    const attachmentText = message.attachment_text as {
      items: Array<Record<string, unknown>>;
      notice: string | null;
    };
    expect(attachmentText.notice).toBeNull();
    expect(attachmentText.items[0]?.filename).toBe(
      '322-password-office-files-password-glavis0603.zip/322-password-zip-inner.docx',
    );
    expect(String(attachmentText.items[0]?.text)).toContain('ふくろう森-322-pwzip');
    expect(String(attachmentText.items[0]?.text)).toContain('PW付きZIP内DOCX読取成功');
  });

  it('extracts text attachments and uses them as ZIP password sources', async () => {
    const encryptedZip = await makeEncryptedZip(
      { 'contract.docx': makeDocx('README内PWでZIP内DOCX読取成功 こあら-322-readme-pw') },
      'glavis0603',
    );
    const fetcher = makeFetchMock(async (url) => {
      if (url.endsWith('/messages/msg_pw_readme')) {
        return jsonResponse(200, {
          id: 'msg_pw_readme',
          subject: 'PW付きZIP',
          text: '添付ZIPをご確認ください。',
          attachments: [
            {
              attachment_id: 'att_readme',
              filename: 'README-実機テスト手順.txt',
              content_type: 'text/plain',
              size: 100,
            },
            {
              attachment_id: 'att_zip',
              filename: 'password-protected.zip',
              content_type: 'application/zip',
              size: encryptedZip.byteLength,
            },
          ],
        });
      }
      if (url.endsWith('/messages/msg_pw_readme/attachments/att_readme')) {
        return new Response('PW付きZIPのパスワードは glavis0603 です。', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      if (url.endsWith('/messages/msg_pw_readme/attachments/att_zip')) {
        return new Response(encryptedZip, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      return new Response('unexpected', { status: 500 });
    });

    const res = await agentmailRead(
      { action: 'get', message_id: 'msg_pw_readme' },
      { ...DEPS, fetcher },
    );

    const message = res.message as Record<string, unknown>;
    const attachmentText = message.attachment_text as {
      items: Array<Record<string, unknown>>;
      notice: string | null;
    };
    expect(attachmentText.notice).toBeNull();
    expect(attachmentText.items[0]?.filename).toBe('README-実機テスト手順.txt');
    expect(String(attachmentText.items[0]?.text)).toContain('パスワードは [REDACTED_SECRET]');
    expect(attachmentText.items[1]?.filename).toBe('password-protected.zip/contract.docx');
    expect(String(attachmentText.items[1]?.text)).toContain('こあら-322-readme-pw');
  });

  it('retries RFC822 message_id with brackets when the first get 404s', async () => {
    const urls: string[] = [];
    const fetcher = makeFetchMock(async (url) => {
      urls.push(url);
      if (url.endsWith('/messages/rfc1%40example.com')) {
        return new Response('not found', { status: 404 });
      }
      expect(url).toBe('https://api.agentmail.to/v0/inboxes/inbox_main/messages/%3Crfc1%40example.com%3E');
      return jsonResponse(200, {
        message_id: '<rfc1@example.com>',
        subject: '回答',
        text: 'bracketed body',
      });
    });
    const res = await agentmailRead(
      { action: 'get', message_id: 'rfc1@example.com' },
      { ...DEPS, fetcher },
    );
    const message = res.message as Record<string, unknown>;
    expect(urls).toEqual([
      'https://api.agentmail.to/v0/inboxes/inbox_main/messages/rfc1%40example.com',
      'https://api.agentmail.to/v0/inboxes/inbox_main/messages/%3Crfc1%40example.com%3E',
    ]);
    expect(message.body).toBe('bracketed body');
  });

  it('falls back to thread_id when message get 404s and returns matching body', async () => {
    const urls: string[] = [];
    const fetcher = makeFetchMock(async (url) => {
      urls.push(url);
      if (url.includes('/messages/')) return new Response('not found', { status: 404 });
      expect(url).toBe(
        'https://api.agentmail.to/v0/inboxes/inbox_main/threads/c7b5b833-bf1b-4d93-97d1-0bf572e866e7',
      );
      return jsonResponse(200, {
        thread_id: 'c7b5b833-bf1b-4d93-97d1-0bf572e866e7',
        messages: [
          {
            message_id: '<older@example.com>',
            from: 'Other <other@example.com>',
            subject: '別件',
            extracted_text: 'wrong body',
          },
          {
            message_id: '<CAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg@mail.gmail.com>',
            thread_id: 'c7b5b833-bf1b-4d93-97d1-0bf572e866e7',
            from: 'Tomohiro Takei <takei@makotoprime.com>',
            subject: 'Fwd: 【初校】巻頭対談(河北新報：水野)',
            extracted_text: '本文が読めました',
            attachments: [{ filename: 'draft.pdf', content_type: 'application/pdf', size: 100 }],
          },
        ],
      });
    });
    const res = await agentmailRead(
      {
        action: 'get',
        message_id: 'CAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg@mail.gmail.com',
        thread_id: 'c7b5b833-bf1b-4d93-97d1-0bf572e866e7',
        from_contains: 'takei@makotoprime.com',
        subject_contains: '巻頭対談',
      },
      { ...DEPS, fetcher },
    );
    const message = res.message as Record<string, unknown>;
    expect(urls).toEqual([
      'https://api.agentmail.to/v0/inboxes/inbox_main/messages/CAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg%40mail.gmail.com',
      'https://api.agentmail.to/v0/inboxes/inbox_main/messages/%3CCAJN01hdj5hXqvSmp67wePx2jL9Px7JbZ7oqgWKUe71VdAtPyOg%40mail.gmail.com%3E',
      'https://api.agentmail.to/v0/inboxes/inbox_main/threads/c7b5b833-bf1b-4d93-97d1-0bf572e866e7',
    ]);
    expect(message.body).toBe('本文が読めました');
    expect(message.attachments).toEqual([
      { filename: 'draft.pdf', content_type: 'application/pdf', size: 100 },
    ]);
  });

  it('fails closed when AgentMail credential is missing', async () => {
    await expect(
      agentmailRead({ action: 'get', message_id: 'msg_1' }, { inboxId: 'inbox_main' }),
    ).rejects.toThrow(/AgentMail の取得に失敗/);
  });
});
