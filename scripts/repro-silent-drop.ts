/**
 * Reproduce the silent drop seen on 2026-05-14 around 06:16:34 EAT.
 *
 * Feeds the agent's exact 663-char reply (extracted from the session
 * transcript) through the same pipeline `processGroupMessages` uses:
 *   1. JSON.stringify if non-string (matches index.ts:368-370)
 *   2. Strip <internal>...</internal> + trim (matches index.ts:372)
 *   3. parseAttachmentMarkers with the real group folder + groups dir
 *
 * Prints raw length, cleaned length, returned text/attachments/rejected,
 * and whether the silent-drop branch would have fired.
 */
import { parseAttachmentMarkers } from '../src/router.js';

const GROUPS_DIR = '/home/ukanga/code/nanoclaw/groups';
const GROUP_FOLDER = 'nini-finance';

// Verbatim text from data/sessions/nini-finance/.claude/projects/-workspace-group/
//   f03f6404-46ef-4e43-b5d8-bf934de2ae6a.jsonl:6411 (msg_01XndKdKbJqQBXkM6YKMusgc)
const agentText =
  "The file is good — 416 formula cells in UFATI Nairobi alone, all referencing named ranges like `UFATI_TotalStudents`, `UFATI_Split_Nairobi` etc. from the Assumptions sheet.\n\n**This is the file for criteria 4 and 5** — `pl-2026.xlsx` has all 25 sheets (assumptions + all 17 P&Ls + support sheets) in one workbook. Changing a driver on the Assumptions tab cascades via named range formulas.\n\nNote: `pl-writer.js` threw a `ReferenceError: ufatiData is not defined` at line 1090 after writing the file — the file completed but there's a code bug at the end. That needs to go into an issue.\n\nSharing `pl-2026.xlsx` now:\n\n[[attach:/workspace/group/outbox/pl-2026.xlsx]]";

function run(label: string, input: unknown) {
  const raw =
    typeof input === 'string' ? input : JSON.stringify(input);
  const cleaned = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
  const parsed = parseAttachmentMarkers(cleaned, GROUP_FOLDER, GROUPS_DIR);
  const wouldSend = Boolean(parsed.text || parsed.attachments.length > 0);

  console.log(`\n=== ${label} ===`);
  console.log(`raw.length:      ${raw.length}`);
  console.log(`cleaned.length:  ${cleaned.length}`);
  console.log(`text.length:     ${parsed.text.length}`);
  console.log(`attachments:     ${JSON.stringify(parsed.attachments)}`);
  console.log(`rejected:        ${JSON.stringify(parsed.rejected)}`);
  console.log(`would send?:     ${wouldSend ? 'YES' : 'NO (silent drop)'}`);
  if (!wouldSend && raw.length > 0) {
    console.log('text preview (first 200 chars):');
    console.log(parsed.text.slice(0, 200));
  }
}

// Scenario 1: plain string (the SDK's normal happy path)
run('Scenario 1: result.result is the raw string', agentText);

// Scenario 2: the SDK packages result as an array of content blocks
// (some Claude Code SDK versions do this for type=result messages)
run('Scenario 2: result.result is an array of content blocks', [
  { type: 'text', text: agentText },
]);

// Scenario 3: only an <internal> block plus a bare marker — proves the
// "everything cleans to empty + marker missing" silent-drop *can* fire
run(
  'Scenario 3: <internal>-only output (degenerate)',
  '<internal>thinking out loud</internal>',
);

// Scenario 4: marker outside /workspace/group/ — rejected, no warn here yet
run(
  'Scenario 4: marker references a forbidden path',
  'Sharing now:\n[[attach:/etc/passwd]]',
);
