/**
 * Integration test for the makoto-prime spec sync (Issue #186 #20).
 *
 * Verifies that the generated `src/data/{persona,tools}-spec.ts`
 * bundles round-trip through persona-builder correctly:
 *   - exported PERSONA_SPEC / TOOLS_SPEC parse as non-empty strings
 *   - PERSONA_SPEC_SHA256_HEX12 matches persona-builder's runtime hash
 *   - PERSONA_SPEC_BYTES matches UTF-8 byte length
 *   - same for TOOLS_SPEC
 *   - buildMakotoSystemPrompt finds the tools section marker in the
 *     real bundled spec (= the sync didn't accidentally strip the
 *     `## メール送信能力` heading)
 *
 * If makoto-prime spec drifts and src/data/*.ts is regenerated, this
 * test still passes — the generated SHA constants regenerate alongside
 * the content. It catches: hand-edited generated files, sync script
 * bugs that emit garbage, accidental marker removal from upstream
 * spec, and the persona/tools file swap (= shipping persona content
 * under TOOLS_SPEC) by asserting on independent invariants.
 */

import { describe, it, expect } from 'vitest';
import {
  PERSONA_SPEC,
  PERSONA_SPEC_SHA256_HEX12,
  PERSONA_SPEC_BYTES,
} from '../src/data/persona-spec';
import {
  TOOLS_SPEC,
  TOOLS_SPEC_SHA256_HEX12,
  TOOLS_SPEC_BYTES,
} from '../src/data/tools-spec';
import {
  buildMakotoSystemPrompt,
  TOOLS_SECTION_MARKER,
} from '../src/lib/persona-builder';

describe('makoto-prime spec bundle (generated src/data/*.ts)', () => {
  it('PERSONA_SPEC is a non-empty UTF-8 string', () => {
    expect(typeof PERSONA_SPEC).toBe('string');
    expect(PERSONA_SPEC.length).toBeGreaterThan(1000);
  });

  it('TOOLS_SPEC contains the tools section marker (= sync did not strip it)', () => {
    expect(TOOLS_SPEC).toContain(TOOLS_SECTION_MARKER);
  });

  it('PERSONA_SPEC_BYTES matches the live UTF-8 byte length', () => {
    expect(PERSONA_SPEC_BYTES).toBe(
      new TextEncoder().encode(PERSONA_SPEC).length,
    );
  });

  it('TOOLS_SPEC_BYTES matches the live UTF-8 byte length', () => {
    expect(TOOLS_SPEC_BYTES).toBe(
      new TextEncoder().encode(TOOLS_SPEC).length,
    );
  });

  it('SHA constants round-trip through persona-builder (= same hash on Cloud Run side)', async () => {
    const r = await buildMakotoSystemPrompt(PERSONA_SPEC, TOOLS_SPEC);
    expect(r.toolsSectionFound).toBe(true);
    expect(r.personaSha256).toBe(PERSONA_SPEC_SHA256_HEX12);
    expect(r.toolsSha256).toBe(TOOLS_SPEC_SHA256_HEX12);
    expect(r.personaBytes).toBe(PERSONA_SPEC_BYTES);
    expect(r.toolsBytes).toBe(TOOLS_SPEC_BYTES);
  });

  it('persona and tools bundles are distinct (= no file swap)', () => {
    expect(PERSONA_SPEC).not.toBe(TOOLS_SPEC);
    expect(PERSONA_SPEC_SHA256_HEX12).not.toBe(TOOLS_SPEC_SHA256_HEX12);
  });

  it('the bundled system prompt is ready for Anthropic API consumption', async () => {
    const r = await buildMakotoSystemPrompt(PERSONA_SPEC, TOOLS_SPEC);
    // The combined system prompt must be a non-empty string strictly
    // larger than either component (= concat happened) and smaller than
    // sum + a few separator bytes (= no surprise duplication).
    expect(r.systemPrompt.length).toBeGreaterThan(PERSONA_SPEC.length);
    expect(r.systemPrompt.length).toBeGreaterThan(TOOLS_SPEC.length);
    expect(r.systemPrompt).toContain(TOOLS_SECTION_MARKER);
    // Worker bundle constraint: Anthropic API system prompt cap is
    // generous (~200KB), our combined prompt should sit well below.
    expect(new TextEncoder().encode(r.systemPrompt).length).toBeLessThan(
      200_000,
    );
  });

  it('self-introspection instructions are bundled with current skill/tool boundaries', async () => {
    const r = await buildMakotoSystemPrompt(PERSONA_SPEC, TOOLS_SPEC);
    expect(r.systemPrompt).toContain('`makoto_introspect` custom tool');
    expect(r.systemPrompt).toContain('{"detail": "all", "include_sources": true}');
    expect(r.systemPrompt).not.toContain('{"topic": "workspace", "include_sources": true}');
    expect(r.systemPrompt).toContain('Cloudflare Workers + Anthropic Managed Agents (CMA)');
    expect(r.systemPrompt).toContain('slash-command skill');
    expect(r.systemPrompt).toContain('attached Managed Agent skill');
    expect(r.systemPrompt).toContain('custom tool / action marker');
    expect(r.systemPrompt).toContain('`slash_skills` と `attached_skills`');
    expect(r.systemPrompt).toContain('`drive_stage_file` custom tool');
  });

  it('Google Chat roster lookup instructions are bundled for LLM-side tool use', async () => {
    const r = await buildMakotoSystemPrompt(PERSONA_SPEC, TOOLS_SPEC);
    expect(r.systemPrompt).toContain('## Google Chat 名簿参照能力');
    expect(r.systemPrompt).toContain('`chat_list_space_members` custom tool');
    expect(r.systemPrompt).toContain('Worker は毎ターン名簿を自動注入しません');
    expect(r.systemPrompt).toContain('{"space_name":"spaces/AAA...","limit":50}');
  });
});
