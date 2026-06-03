import { SLASH_SKILLS_DATA } from '../data/skills-data';
import { PERSONA_SPEC } from '../data/persona-spec';
import { TOOLS_SPEC } from '../data/tools-spec';
import { BUILT_IN_DOCUMENT_SKILL_IDS } from './attached-skills';
import { buildMakotoSystemPrompt } from './persona-builder';

export type MakotoToolName =
  | 'drive_search'
  | 'drive_get_file_metadata'
  | 'drive_read_export'
  | 'drive_create_file'
  | 'drive_delete'
  | 'sheets_create'
  | 'sheets_read'
  | 'sheets_update'
  | 'sheets_append'
  | 'calendar_list_events'
  | 'chat_list_space_members'
  | 'agentmail_read'
  | 'makoto_introspect';

type IntrospectionDetail =
  | 'summary'
  | 'tools'
  | 'skills'
  | 'limits'
  | 'mcp'
  | 'memory'
  | 'routing'
  | 'classification'
  | 'all';

const INTROSPECTION_DETAILS = new Set<IntrospectionDetail>([
  'summary',
  'tools',
  'skills',
  'limits',
  'mcp',
  'memory',
  'routing',
  'classification',
  'all',
]);

export const MAKOTO_CUSTOM_TOOL_CAPABILITIES: ReadonlyArray<{
  name: MakotoToolName;
  description: string;
  status: 'cloudflare_code' | 'cloudflare_code_live_observed' | 'cloudflare_code_live_unverified';
  requires_workspace_oauth: boolean;
}> = [
  {
    name: 'drive_search',
    description: 'Google Drive files search within the caller permission boundary.',
    status: 'cloudflare_code_live_observed',
    requires_workspace_oauth: true,
  },
  {
    name: 'drive_get_file_metadata',
    description: 'Read Google Drive file metadata.',
    status: 'cloudflare_code_live_unverified',
    requires_workspace_oauth: true,
  },
  {
    name: 'drive_read_export',
    description: 'Read/export Google Docs, Sheets, Slides, or supported Drive files.',
    status: 'cloudflare_code_live_unverified',
    requires_workspace_oauth: true,
  },
  {
    name: 'drive_create_file',
    description: 'Create a Google Drive file within size limits.',
    status: 'cloudflare_code_live_unverified',
    requires_workspace_oauth: true,
  },
  {
    name: 'drive_delete',
    description: 'Move an eligible Drive file to trash after same-message confirmation.',
    status: 'cloudflare_code_live_unverified',
    requires_workspace_oauth: true,
  },
  {
    name: 'sheets_create',
    description: 'Create a Google Spreadsheet.',
    status: 'cloudflare_code_live_unverified',
    requires_workspace_oauth: true,
  },
  {
    name: 'sheets_read',
    description: 'Read a Google Sheets range.',
    status: 'cloudflare_code_live_unverified',
    requires_workspace_oauth: true,
  },
  {
    name: 'sheets_update',
    description: 'Overwrite a specified Google Sheets range.',
    status: 'cloudflare_code_live_unverified',
    requires_workspace_oauth: true,
  },
  {
    name: 'sheets_append',
    description: 'Append rows to an existing Google Sheets table.',
    status: 'cloudflare_code_live_unverified',
    requires_workspace_oauth: true,
  },
  {
    name: 'calendar_list_events',
    description: 'List Google Calendar events for a requested time range.',
    status: 'cloudflare_code_live_unverified',
    requires_workspace_oauth: true,
  },
  {
    name: 'chat_list_space_members',
    description: 'List Google Chat space members when roster context is needed.',
    status: 'cloudflare_code_live_unverified',
    requires_workspace_oauth: false,
  },
  {
    name: 'agentmail_read',
    description: 'Read/search the default AgentMail inbox without sending or mutating mail.',
    status: 'cloudflare_code_live_unverified',
    requires_workspace_oauth: false,
  },
  {
    name: 'makoto_introspect',
    description: 'Return a safe self-description of MAKOTO capabilities and boundaries.',
    status: 'cloudflare_code',
    requires_workspace_oauth: false,
  },
];

export const MAKOTO_TOOL_NAMES = MAKOTO_CUSTOM_TOOL_CAPABILITIES.map(
  (tool) => tool.name,
) as readonly MakotoToolName[];

export const MAKOTO_AGENT_TOOLS: ReadonlyArray<Record<string, unknown>> = [
  { type: 'agent_toolset_20260401' },
  ...MAKOTO_CUSTOM_TOOL_CAPABILITIES.map((tool) => ({
    type: 'custom',
    name: tool.name,
    description: tool.description,
    input_schema: inputSchemaForTool(tool.name),
  })),
];

const ACTION_MARKERS = [
  {
    name: 'EMAIL_SEND',
    status: 'cloudflare_code_live_observed',
    description: 'Bot-side AgentMail send marker parsed from assistant text.',
  },
  {
    name: 'CHAT_POST',
    status: 'cloudflare_code_live_observed',
    description: 'Bot-side Google Chat post marker for posting outside the current reply.',
  },
  {
    name: 'SCHEDULE_ACTION',
    status: 'cloudflare_code_live_unverified',
    description: 'Bot-side scheduled job management marker.',
  },
] as const;

const OBSERVED_MANAGED_AGENT_TOOLS = [
  {
    name: 'bash',
    source: 'CMA sessions.events live observation',
    status: 'live_observed',
  },
  {
    name: 'drive_search',
    source: 'CMA sessions.events live observation',
    status: 'live_observed',
  },
] as const;

const CUSTOM_SKILL_ENV = [
  { label: 'provenance', idKey: 'PROVENANCE_SKILL_ID', versionKey: 'PROVENANCE_SKILL_VERSION' },
  { label: 'cloudrun', idKey: 'CLOUDRUN_SKILL_ID', versionKey: 'CLOUDRUN_SKILL_VERSION' },
  { label: 'mail-send', idKey: 'MAIL_SEND_SKILL_ID', versionKey: 'MAIL_SEND_SKILL_VERSION' },
  { label: 'cost-guard', idKey: 'COST_GUARD_SKILL_ID', versionKey: 'COST_GUARD_SKILL_VERSION' },
] as const;

export async function buildMakotoIntrospection(
  input: Record<string, unknown>,
  env?: Env,
): Promise<Record<string, unknown>> {
  const detail = parseIntrospectionDetail(input.detail);
  const includeSources = input.include_sources !== false;
  let promptSource: Record<string, unknown>;
  try {
    const result = await buildMakotoSystemPrompt(PERSONA_SPEC, TOOLS_SPEC);
    promptSource = {
      persona_bytes: result.personaBytes,
      persona_sha256: result.personaSha256,
      tools_bytes: result.toolsBytes,
      tools_sha256: result.toolsSha256,
      tools_section_found: result.toolsSectionFound,
    };
  } catch (err) {
    promptSource = {
      error: 'prompt_source_unavailable',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const base: Record<string, unknown> = {
    schema_version: 2,
    product: '汎用CMAエージェント Cloudflare版',
    runtime: 'cloudflare_worker',
    generated_at: new Date().toISOString(),
    requested_detail: detail,
    status: {
      cloudflare_runtime: 'primary',
      cloud_run: 'rollback_fallback_only',
      live_verification: 'partial_observed',
    },
    source:
      'Worker-bundled capability registry derived from Cloudflare dispatcher, attached skill config, prompt specs, and runtime observation notes. No secrets, raw logs, or arbitrary source files are exposed.',
    prompt_source: promptSource,
    summary: [
      'Google Chat and AgentMail entrypoints drive Anthropic Managed Agent sessions on Cloudflare Workers.',
      'The agent uses per-user Google Workspace OAuth only through Worker-side tools; credentials are not exposed to the agent.',
      'Memory attachments are resolved by Cloudflare-side routing before creating or reusing a session.',
      'Google Chat space roster is not injected every turn; the agent can call chat_list_space_members when needed.',
      'External write/send/delete operations are guarded by custom tool or marker contracts.',
      'MCP is not an active Google Workspace path; current Workspace access is Worker-side REST tooling.',
    ],
    identity_model: {
      template: 'generic_agent',
      instance_identity_source: 'agent/user mapping and per-agent memory, not hard-coded system prompt literals.',
      instance_variables: [
        'agent_number',
        'agent_display_name',
        'owner_display_name',
        'organization_name',
        'agent_role',
        'voice_style',
      ],
    },
    memory_strategy: {
      plan: 'plan_b_memory_store_primary',
      max_session_memory_stores: 8,
      router_owner: 'src/lib/memory-attach.ts + src/lib/session-orchestrator.ts',
      selection_point: 'Cloudflare Worker selects sessions.create resources[] before the CMA session starts.',
      corporate_wiki: {
        role: 'Interpreted corporate brain / LLM Wiki built on Memory Store.',
        mount_policy: 'Always selected first when present.',
        raw_source: 'Google Drive meeting minutes and documents remain primary source links.',
      },
      logs_and_reports: {
        naming: 'Numbered agent-specific stores, e.g. agent_0001_session_log_store and agent_0001_daily_report_store.',
        policy: 'Session logs and daily reports stay in one numbered owner-agent Memory Store regardless of DM or shared space.',
        drive_role: 'Drive is source/archive for primary documents, not the default memory carrier.',
      },
    },
    cannot_claim: [
      'Do not claim active MCP connectors for Google Workspace; they are not the current implementation path.',
      'Do not claim Cloud Run is the primary runtime for Cloudflare版.',
      'Do not claim the LLM automatically chooses which Memory Stores to mount; the Worker router chooses resources[].',
      'Do not claim Google Chat roster is always preloaded; use chat_list_space_members if roster context is needed.',
      'Do not claim env-specific Workspace operations are available for a user before OAuth/bootstrap/live verification.',
      'Do not expose secret names, token state, raw payload audit, session ids, or internal stack traces to normal Chat users.',
    ],
  };

  if (detail === 'summary') return base;

  if (detail === 'tools' || detail === 'all') {
    base.custom_tools = MAKOTO_CUSTOM_TOOL_CAPABILITIES;
    base.action_markers = ACTION_MARKERS;
    base.observed_managed_agent_tools = OBSERVED_MANAGED_AGENT_TOOLS;
  }

  if (detail === 'skills' || detail === 'all') {
    base.slash_skills = Object.entries(SLASH_SKILLS_DATA.skills ?? {}).map(([command, skill]) => ({
      command,
      name: skill.name,
      description: skill.description,
      attach_memory: skill.attach_memory !== false,
    }));
    base.attached_skills = buildAttachedSkillInventory(env);
  }

  if (detail === 'mcp' || detail === 'all') {
    base.mcp = {
      active_connectors: [],
      status: 'not_active_for_workspace',
      current_workspace_path: 'Worker-side REST custom tools with per-user OAuth.',
      reserved_future_path: 'Anthropic Vault/MCP may be revisited later, but is not current production capability.',
    };
  }

  if (detail === 'memory' || detail === 'routing' || detail === 'classification' || detail === 'all') {
    base.memory_router = {
      strategy: 'plan_b_memory_store_router_v1',
      hard_limit: 8,
      priority_order: [
        'corporate_wiki_memory / corporate_brain / company_wiki',
        'company_core_memory',
        'agent_0001_identity_memory / agent_0001_profile_memory / persona_memory',
        'agent_0001_support_memory for the owner support context',
        'agent_0001_daily_report_store / daily_report_store for the owner agent',
        'agent_0001_session_log_store / session_log_store for the owner agent',
        'legacy DM/shared daily/log aliases as compatibility inputs',
        'remaining stores in declared order',
      ],
      privacy_rule:
        'Owner-agent memory is unified across DM and shared spaces; shared-space replies still apply speaker/space permission and should not disclose unrelated private owner context.',
      session_reuse_rule:
        'Memory resources hash is included in the Chat session key so changed attachments do not reuse a stale session.',
    };
  }

  if (detail === 'classification' || detail === 'all') {
    base.system_memory_logic_classification = {
      system_prompt: [
        'Generic role, tone, output format, safety boundaries, trust boundary, and correct Cloudflare/CMA self-recognition.',
        'Instance-specific identity is injected by mapping/addendum/memory, not hard-coded in the generic prompt.',
        'What the agent must never claim, such as active Workspace MCP or Cloud Run as primary runtime.',
      ],
      memory: [
        'Corporate wiki / LLM Wiki on Memory Store as interpreted company brain.',
        'Numbered agent-specific identity/profile/support memory, company core facts, session logs, and daily reports, with owner-agent unified logs.',
        'Google Drive links and primary source references recorded inside wiki/log entries when source tracing matters.',
      ],
      logic: [
        'Cloudflare session resolver and Memory Store router selecting sessions.create resources[].',
        'Permission gates for Workspace/AgentMail/Chat writes and per-user OAuth subject resolution.',
        'Thin Chat boundary: route sender/session/resources, execute requested tools, and avoid speculative prompt/context injection.',
      ],
    };
  }

  if (detail === 'limits' || detail === 'all') {
    base.safety_boundaries = [
      'Does not expose secrets, OAuth tokens, environment keys, raw Cloudflare logs, or raw payload audit.',
      'Does not provide arbitrary source-code read access from the agent session.',
      'Workspace tools execute with the resolved caller user permission, not borrowed agent ownership.',
      'Drive deletion is trash-only and requires confirmation token flow.',
      'Email, Chat posting, and schedule changes use bot-side markers and server-side gates.',
      'Shared-space replies must not expose private owner memory unless the current request and permissions justify it.',
    ];
  }

  if (includeSources) {
    base.registry_sources = [
      'src/dispatch/makoto-tool-dispatcher.ts',
      'src/lib/managed-agent-tools.ts',
      'src/lib/attached-skills.ts',
      'src/lib/session-orchestrator.ts',
      'products/makoto-kun/specs/system-prompt-tools.md',
      'products/makoto-kun/specs/cloudflare-agent-session-skill-design.md',
    ];
  }

  return base;
}

function buildAttachedSkillInventory(env: Env | undefined): Array<Record<string, unknown>> {
  const builtIn = BUILT_IN_DOCUMENT_SKILL_IDS.map((skill_id) => ({
    type: 'anthropic',
    skill_id,
    status: 'managed_agent_skill',
  }));
  const custom = CUSTOM_SKILL_ENV.map((spec) => ({
    type: 'custom',
    label: spec.label,
    configured: env ? envString(env, spec.idKey).length > 0 : 'unknown',
    version_configured: env ? envString(env, spec.versionKey).length > 0 : 'unknown',
  }));
  return [...builtIn, ...custom];
}

function parseIntrospectionDetail(value: unknown): IntrospectionDetail {
  if (typeof value !== 'string') return 'all';
  const normalized = value.trim().toLowerCase();
  return INTROSPECTION_DETAILS.has(normalized as IntrospectionDetail)
    ? (normalized as IntrospectionDetail)
    : 'all';
}

function envString(env: Env, key: string): string {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function inputSchemaForTool(name: MakotoToolName): Record<string, unknown> {
  switch (name) {
    case 'drive_search':
      return objectSchema(
        {
          query: stringProp('Google Drive q expression. trashed=false is added by the tool.'),
          page_size: numberProp('Optional result cap. 1-50, default 20.'),
          order_by: stringProp('Optional Drive orderBy, default modifiedTime desc.'),
          corpora: enumProp(['user', 'allDrives'], 'Optional corpus. Default user.'),
        },
        ['query'],
      );
    case 'drive_get_file_metadata':
      return objectSchema(
        {
          file_id: stringProp('Google Drive file id.'),
          fields: stringProp('Optional comma-separated metadata fields whitelist.'),
        },
        ['file_id'],
      );
    case 'drive_read_export':
      return objectSchema(
        {
          file_id: stringProp('Google Drive file id.'),
          format: stringProp('Optional export format such as text/plain or markdown.'),
          max_chars: numberProp('Optional character cap for exported text.'),
        },
        ['file_id'],
      );
    case 'drive_create_file':
      return objectSchema(
        {
          name: stringProp('File name to create.'),
          content: stringProp('File content.'),
          mime_type: stringProp('Optional MIME type. Default text/plain.'),
          parents: arrayProp('Optional parent Drive folder ids.'),
        },
        ['name', 'content'],
      );
    case 'drive_delete':
      return objectSchema(
        {
          file_id: stringProp('Google Drive file id to move to trash.'),
          confirmation_token: stringProp('Token returned by the first confirmation_required call.'),
        },
        ['file_id'],
      );
    case 'sheets_create':
      return objectSchema({ title: stringProp('Spreadsheet title.') }, ['title']);
    case 'sheets_read':
      return objectSchema(
        {
          spreadsheet_id: stringProp('Google Spreadsheet id.'),
          range: stringProp('A1 range, e.g. Sheet1!A1:B10.'),
        },
        ['spreadsheet_id', 'range'],
      );
    case 'sheets_update':
    case 'sheets_append':
      return objectSchema(
        {
          spreadsheet_id: stringProp('Google Spreadsheet id.'),
          range: stringProp('A1 range.'),
          values: arrayProp('2D array of rows and cells.'),
        },
        ['spreadsheet_id', 'range', 'values'],
      );
    case 'calendar_list_events':
      return objectSchema(
        {
          time_min: stringProp('RFC3339 inclusive lower bound, usually Asia/Tokyo offset.'),
          time_max: stringProp('RFC3339 exclusive upper bound, usually Asia/Tokyo offset.'),
          max_results: numberProp('Optional result cap. 1-50, default 10.'),
          calendar_id: stringProp('Optional calendar id. Default primary.'),
        },
        ['time_min', 'time_max'],
      );
    case 'chat_list_space_members':
      return objectSchema(
        {
          space_name: stringProp(
            'Optional Google Chat space resource name. Defaults to the current inbound space.',
          ),
          limit: numberProp('Optional member cap. 1-100, default 50.'),
        },
        [],
      );
    case 'agentmail_read':
      return objectSchema(
        {
          action: enumProp(['search', 'get'], 'search for messages or get one message.'),
          message_id: stringProp('Required for get. AgentMail message id.'),
          from_contains: stringProp('Optional sender substring for search.'),
          subject_contains: stringProp('Optional subject substring for search.'),
          query: stringProp('Optional broad metadata query for search.'),
          after: stringProp('Optional ISO timestamp lower bound.'),
          before: stringProp('Optional ISO timestamp upper bound.'),
          labels: arrayProp('Optional label filters.'),
          limit: numberProp('Optional search cap. 1-20, default 10.'),
          max_chars: numberProp('Optional body character cap for get.'),
        },
        ['action'],
      );
    case 'makoto_introspect':
      return objectSchema(
        {
          detail: enumProp(
            [
              'summary',
              'tools',
              'skills',
              'limits',
              'mcp',
              'memory',
              'routing',
              'classification',
              'all',
            ],
            'Requested inventory scope. Use all when unsure.',
          ),
          include_sources: {
            type: 'boolean',
            description: 'Whether to include source file references. Default true.',
          },
        },
        [],
      );
  }
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
  };
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function numberProp(description: string): Record<string, unknown> {
  return { type: 'integer', description };
}

function arrayProp(description: string): Record<string, unknown> {
  return { type: 'array', description };
}

function enumProp(values: string[], description: string): Record<string, unknown> {
  return { type: 'string', enum: values, description };
}
