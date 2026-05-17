/**
 * Migrate v1 registered_groups → v2 (agent_groups + messaging_groups + wirings).
 *
 * v2 has no automatic v1→v2 migration (CLAUDE.md references `migrate-v2.sh`
 * but the script doesn't exist). This is the one-shot cutover utility for
 * recreating channel wiring from a v1 `store/messages.db` snapshot.
 *
 * What it does (per v1 `registered_groups` row):
 *   1. Creates an `agent_groups` row keyed by the existing `folder`.
 *      The folder under `groups/` is kept in place (CLAUDE.md, skills,
 *      scratch all preserved). `initGroupFilesystem` is idempotent — it
 *      only writes files that don't exist.
 *   2. For `signal:*` JIDs, creates a `messaging_groups` row and wires it
 *      to the agent group via `messaging_group_agents`.
 *   3. For `cli:*` JIDs, skips messaging-group creation — the user wires
 *      `cli/local` separately via `scripts/init-cli-agent.ts` or
 *      `/manage-channels` (they may want this agent OR a fresh one).
 *
 * Engage-mode defaults match v1 trigger semantics:
 *   - Signal DM (platform_id NOT starting with "group:") → `pattern` + `.`
 *     so every message wakes the agent (matches v1 DM behaviour).
 *   - Signal group → `mention-sticky` so the agent wakes on name mention
 *     and stays engaged until idle (matches v1's mention-based trigger).
 *
 * The script is idempotent and dry-run by default. Re-runs are safe.
 *
 * Usage:
 *   pnpm exec tsx scripts/migrate-v1-groups.ts                  # dry-run
 *   pnpm exec tsx scripts/migrate-v1-groups.ts --apply          # commit
 *   pnpm exec tsx scripts/migrate-v1-groups.ts --src <db-path>  # custom v1 db
 */
import Database from 'better-sqlite3';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from '../src/types.js';

interface Args {
  src: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  let src = 'store.v1-backup/messages.db';
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--src') {
      if (!val) {
        console.error('--src needs a path');
        process.exit(2);
      }
      src = val;
      i++;
    } else if (key === '--apply') {
      apply = true;
    } else if (key === '-h' || key === '--help') {
      console.log(
        'Usage: pnpm exec tsx scripts/migrate-v1-groups.ts [--src <v1-db>] [--apply]',
      );
      process.exit(0);
    } else {
      console.error(`unknown arg: ${key}`);
      process.exit(2);
    }
  }
  return { src, apply };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface V1Group {
  folder: string;
  name: string;
  jid: string;
  is_main: number;
}

interface Parsed {
  channelType: string;
  platformId: string;
  isGroup: boolean;
}

function parseJid(jid: string): Parsed | null {
  const colon = jid.indexOf(':');
  if (colon === -1) return null;
  const channelType = jid.slice(0, colon);
  let platformId = jid.slice(colon + 1);
  // Signal group JIDs are stored as `signal:group:<base64>`; v2 keeps the
  // `group:` prefix on `platform_id` (see src/channels/signal.ts:780).
  const isGroup = platformId.startsWith('group:');
  return { channelType, platformId, isGroup };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const srcPath = path.resolve(args.src);

  console.log(`Source (v1):  ${srcPath}`);
  console.log(`Target (v2):  ${path.join(DATA_DIR, 'v2.db')}`);
  console.log(`Mode:         ${args.apply ? 'APPLY (writes)' : 'DRY RUN'}`);
  console.log('');

  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  const rows = src
    .prepare('SELECT folder, name, jid, is_main FROM registered_groups ORDER BY name')
    .all() as V1Group[];
  src.close();

  if (rows.length === 0) {
    console.log('No registered_groups rows found in source. Nothing to do.');
    return;
  }

  // Initialise the v2 DB connection up front so migrations are applied even
  // in dry-run mode (read-only inspection of an unmigrated DB would fail).
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();
  let agentGroupsCreated = 0;
  let messagingGroupsCreated = 0;
  let wiringsCreated = 0;
  let skipped = 0;

  for (const row of rows) {
    console.log(`── ${row.name} (folder=${row.folder}, jid=${row.jid})`);

    // 1. Agent group.
    let ag: AgentGroup | undefined = getAgentGroupByFolder(row.folder);
    if (!ag) {
      const newAg: AgentGroup = {
        id: generateId('ag'),
        name: row.name,
        folder: row.folder,
        agent_provider: null,
        created_at: now,
      };
      if (args.apply) {
        createAgentGroup(newAg);
        initGroupFilesystem(newAg);
        ag = getAgentGroupByFolder(row.folder)!;
      } else {
        ag = newAg;
      }
      agentGroupsCreated++;
      console.log(`   + agent_group  ${ag.id}  folder=${ag.folder}`);
    } else {
      console.log(`   = agent_group  ${ag.id}  (already exists, skipping)`);
    }

    const parsed = parseJid(row.jid);
    if (!parsed) {
      console.log(`   ! could not parse jid; skipping messaging wiring`);
      skipped++;
      continue;
    }

    // 2. Messaging group + wiring.
    if (parsed.channelType === 'cli') {
      console.log(
        `   ~ cli/* mapping skipped — wire ${row.folder} to cli/local manually via init-cli-agent or /manage-channels`,
      );
      skipped++;
      continue;
    }

    let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(
      parsed.channelType,
      parsed.platformId,
    );
    if (!mg) {
      const newMg: MessagingGroup = {
        id: generateId('mg'),
        channel_type: parsed.channelType,
        platform_id: parsed.platformId,
        name: row.name,
        is_group: parsed.isGroup ? 1 : 0,
        unknown_sender_policy: 'public',
        created_at: now,
      };
      if (args.apply) {
        createMessagingGroup(newMg);
        mg = getMessagingGroupByPlatform(parsed.channelType, parsed.platformId)!;
      } else {
        mg = newMg;
      }
      messagingGroupsCreated++;
      console.log(
        `   + messaging_group  ${mg.id}  channel=${mg.channel_type} platform_id=${mg.platform_id}`,
      );
    } else {
      console.log(`   = messaging_group  ${mg.id}  (already exists)`);
    }

    const wired = getMessagingGroupAgentByPair(mg.id, ag.id);
    if (!wired) {
      const mga: MessagingGroupAgent = {
        id: generateId('mga'),
        messaging_group_id: mg.id,
        agent_group_id: ag.id,
        engage_mode: parsed.isGroup ? 'mention-sticky' : 'pattern',
        engage_pattern: parsed.isGroup ? null : '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now,
      };
      if (args.apply) {
        createMessagingGroupAgent(mga);
      }
      wiringsCreated++;
      console.log(
        `   + wiring          ${mga.id}  engage=${mga.engage_mode}${
          mga.engage_pattern ? `(${mga.engage_pattern})` : ''
        }`,
      );
    } else {
      console.log(`   = wiring          ${wired.id}  (already wired)`);
    }
  }

  console.log('');
  console.log('Summary:');
  console.log(`  agent_groups created:     ${agentGroupsCreated}`);
  console.log(`  messaging_groups created: ${messagingGroupsCreated}`);
  console.log(`  wirings created:          ${wiringsCreated}`);
  console.log(`  skipped (cli/* or bad jid): ${skipped}`);
  if (!args.apply) {
    console.log('');
    console.log('Dry run only — re-run with --apply to commit.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
