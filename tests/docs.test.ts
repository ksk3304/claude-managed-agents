/**
 * Unit tests for `src/tools/docs.ts` — Google Docs custom tools.
 */

import { describe, expect, it } from 'vitest';
import { docsBatchUpdate, docsCreate, docsGet, type DocsToolDeps } from '../src/tools/docs';
import { makeFetchMock } from './makoto-helpers';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deps(fetcher: typeof fetch): DocsToolDeps {
  return { accessToken: 'ya29.test', fetcher };
}

describe('docsCreate', () => {
  it('creates a document and inserts initial text when provided', async () => {
    const fetcher = makeFetchMock(async (url, init) => {
      if (url.endsWith('/documents')) {
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ title: '議事録' });
        return jsonResponse(200, { documentId: 'doc-1', title: '議事録' });
      }
      expect(url).toContain('/documents/doc-1:batchUpdate');
      expect(init.method).toBe('POST');
      const body = JSON.parse(String(init.body)) as { requests: unknown[] };
      expect(body.requests).toEqual([
        { insertText: { location: { index: 1 }, text: '本文です' } },
      ]);
      return jsonResponse(200, { documentId: 'doc-1', replies: [{}] });
    });
    const r = await docsCreate({ title: '議事録', initial_text: '本文です' }, deps(fetcher));
    expect(r.document_id).toBe('doc-1');
    expect(r.document_url).toBe('https://docs.google.com/document/d/doc-1/edit');
    expect(fetcher.calls).toHaveLength(2);
  });
});

describe('docsGet', () => {
  it('extracts text from paragraphs and truncates by max_chars', async () => {
    const fetcher = makeFetchMock(async () =>
      jsonResponse(200, {
        title: 'Doc',
        revisionId: 'rev-1',
        body: {
          content: [
            {
              paragraph: {
                elements: [{ textRun: { content: 'hello ' } }, { textRun: { content: 'world' } }],
              },
            },
          ],
        },
      }),
    );
    const r = await docsGet({ document_id: 'doc-1', max_chars: 5 }, deps(fetcher));
    expect(r.title).toBe('Doc');
    expect(r.body_text).toBe('hello');
    expect(r.truncated).toBe(true);
    expect(r.revision_id).toBe('rev-1');
  });
});

describe('docsBatchUpdate', () => {
  it('posts raw Docs API batchUpdate requests', async () => {
    const fetcher = makeFetchMock(async (url, init) => {
      expect(url).toContain('/documents/doc-1:batchUpdate');
      expect(init.method).toBe('POST');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.requests).toEqual([{ deleteContentRange: { range: { startIndex: 1, endIndex: 3 } } }]);
      expect(body.writeControl).toEqual({ requiredRevisionId: 'rev-1' });
      return jsonResponse(200, { documentId: 'doc-1', replies: [{ ok: true }] });
    });
    const r = await docsBatchUpdate(
      {
        document_id: 'doc-1',
        requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 3 } } }],
        write_control: { requiredRevisionId: 'rev-1' },
      },
      deps(fetcher),
    );
    expect(r.replies).toEqual([{ ok: true }]);
  });
});
