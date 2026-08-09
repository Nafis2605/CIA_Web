// server/src/__tests__/annotations-broadcast.test.js
// Unit tests for resolveBroadcastProjects in server/src/routes/annotations.js (no DB required)
//
// H15: resolveBroadcastProjects used to seed its result with a caller-
// supplied bodyProjectId in addition to file_project_access rows — since
// that value is never validated, a legitimate creator could smuggle in an
// unrelated project and leak the new annotation to that project's members.
// It no longer accepts or trusts a body-supplied projectId at all; broadcast
// targets come from file_project_access alone.

'use strict';

const { resolveBroadcastProjects } = require('../routes/annotations');

describe('resolveBroadcastProjects', () => {
  test('empty file_project_access table — empty Set, regardless of any caller-supplied value', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const result = await resolveBroadcastProjects(pool, 'file-1');
    expect(result).toEqual(new Set());
  });

  test('table returns two rows', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ project_id: 'project-a' }, { project_id: 'project-b' }],
      }),
    };
    const result = await resolveBroadcastProjects(pool, 'file-1');
    expect(result).toEqual(new Set(['project-a', 'project-b']));
  });

  test('table returns one row — Set of size 1', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ project_id: 'project-x' }] }),
    };
    const result = await resolveBroadcastProjects(pool, 'file-1');
    expect(result.size).toBe(1);
    expect(result).toEqual(new Set(['project-x']));
  });

  test('empty table — empty Set', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const result = await resolveBroadcastProjects(pool, 'file-1');
    expect(result.size).toBe(0);
  });

  test('pool.query rejects — does not throw, resolves to an empty Set', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    await expect(resolveBroadcastProjects(pool, 'file-1')).resolves.toEqual(new Set());
  });
});
