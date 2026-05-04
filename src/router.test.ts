import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { parseAttachmentMarkers } from './router.js';

describe('parseAttachmentMarkers', () => {
  let groupsBaseDir: string;
  const groupFolder = 'team-a';

  beforeEach(() => {
    groupsBaseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'router-test-groups-'),
    );
  });

  afterEach(() => {
    fs.rmSync(groupsBaseDir, { recursive: true, force: true });
  });

  it('translates a single marker to absolute host path', () => {
    const result = parseAttachmentMarkers(
      'Here is the file [[attach:/workspace/group/outbox/report.pdf]]',
      groupFolder,
      groupsBaseDir,
    );
    expect(result.text).toBe('Here is the file');
    expect(result.attachments).toEqual([
      path.join(groupsBaseDir, groupFolder, 'outbox', 'report.pdf'),
    ]);
    expect(result.rejected).toEqual([]);
  });

  it('extracts multiple markers in one message', () => {
    const result = parseAttachmentMarkers(
      'Files: [[attach:/workspace/group/outbox/a.pdf]] and [[attach:/workspace/group/outbox/b.xlsx]]',
      groupFolder,
      groupsBaseDir,
    );
    expect(result.attachments).toEqual([
      path.join(groupsBaseDir, groupFolder, 'outbox', 'a.pdf'),
      path.join(groupsBaseDir, groupFolder, 'outbox', 'b.xlsx'),
    ]);
    expect(result.text).toBe('Files:  and');
    expect(result.rejected).toEqual([]);
  });

  it('rejects markers without /workspace/group/ prefix', () => {
    const result = parseAttachmentMarkers(
      'Bad path [[attach:/etc/passwd]]',
      groupFolder,
      groupsBaseDir,
    );
    expect(result.attachments).toEqual([]);
    expect(result.rejected).toEqual(['/etc/passwd']);
    expect(result.text).toBe('Bad path');
  });

  it('rejects markers attempting path traversal', () => {
    const result = parseAttachmentMarkers(
      '[[attach:/workspace/group/../../etc/passwd]]',
      groupFolder,
      groupsBaseDir,
    );
    expect(result.attachments).toEqual([]);
    expect(result.rejected).toEqual([
      '/workspace/group/../../etc/passwd',
    ]);
    expect(result.text).toBe('');
  });

  it('passes plain text through untouched', () => {
    const result = parseAttachmentMarkers(
      'Just a regular reply with no markers.',
      groupFolder,
      groupsBaseDir,
    );
    expect(result.text).toBe('Just a regular reply with no markers.');
    expect(result.attachments).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('tidies whitespace left behind by stripped markers', () => {
    const result = parseAttachmentMarkers(
      'Line one\n\n\n[[attach:/workspace/group/outbox/x.pdf]]\n\n\nLine two',
      groupFolder,
      groupsBaseDir,
    );
    expect(result.text).toBe('Line one\n\nLine two');
    expect(result.attachments).toEqual([
      path.join(groupsBaseDir, groupFolder, 'outbox', 'x.pdf'),
    ]);
  });

  it('handles filenames with spaces', () => {
    const result = parseAttachmentMarkers(
      '[[attach:/workspace/group/outbox/Q1 budget revision.xlsx]]',
      groupFolder,
      groupsBaseDir,
    );
    expect(result.attachments).toEqual([
      path.join(
        groupsBaseDir,
        groupFolder,
        'outbox',
        'Q1 budget revision.xlsx',
      ),
    ]);
    expect(result.rejected).toEqual([]);
  });

  it('mixes good and bad markers in the same message', () => {
    const result = parseAttachmentMarkers(
      '[[attach:/workspace/group/outbox/good.pdf]] and [[attach:/etc/shadow]]',
      groupFolder,
      groupsBaseDir,
    );
    expect(result.attachments).toEqual([
      path.join(groupsBaseDir, groupFolder, 'outbox', 'good.pdf'),
    ]);
    expect(result.rejected).toEqual(['/etc/shadow']);
    expect(result.text).toBe('and');
  });
});
