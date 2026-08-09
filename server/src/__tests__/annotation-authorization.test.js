// server/src/__tests__/annotation-authorization.test.js
// H15: POST /api/annotations (and /batch) only checked project membership
// `if (projectId)` was present in the request body — omitting it (as the VR
// client legitimately does for locally-loaded datasets) skipped the check
// entirely, letting a non-member annotate any known file id. The fix derives
// authorization from the file's OWN project associations (file_project_access)
// server-side, and never trusts a client-supplied projectId either way.
//
// ─── AUTO-SKIP ─────────────────────────────────────────────────────────────
// Tests auto-skip if TEST_DATABASE_URL is not set.
//
// ─── SETUP ──────────────────────────────────────────────────────────────────
//   1. docker-compose up -d cia-postgres
//   2. TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//      DEV_BYPASS_AUTH=true \
//      cd server && npm test -- --testPathPattern "annotation-authorization" --runInBand

'use strict';

const request = require('supertest');
const {
  createTestPool,
  integrationDescribe,
  SEED,
} = require('./helpers/dbFixture');
const { createTestApp } = require('./helpers/testApp');

const pool = createTestPool();

integrationDescribe('Annotation creation authorization (H15)', pool, () => {
  let app;
  let mockWsManager;
  const ORG_ID = '00000000-0000-0000-0000-000000000000';
  const ALICE = SEED.USER_ALICE;
  const BOB = SEED.USER_BOB;

  let privateProjectId;
  let otherProjectId; // Alice is also a member here, but it's unrelated to any file
  let fileWithProjectId; // belongs to privateProjectId, owned by Alice
  let fileNoProjectId; // no file_project_access rows at all, owned by Alice

  const createdAnnotationIds = [];

  // The dev-bypass auth middleware only honors a custom x-user-id when
  // x-user-name is ALSO present — otherwise it silently falls back to the
  // default mock user regardless of x-user-id (see middleware/auth.js).
  const USER_NAMES = { [ALICE]: 'Alice Analyst', [BOB]: 'Bob Builder' };

  function authHeaders(userId) {
    return {
      'x-user-id': userId,
      'x-user-name': USER_NAMES[userId] || 'Test User',
      'Content-Type': 'application/json',
    };
  }

  beforeAll(async () => {
    app = createTestApp(pool);
    mockWsManager = {
      annotationCreated: jest.fn(),
      annotationUpdated: jest.fn(),
      annotationDeleted: jest.fn(),
      broadcastToProject: jest.fn(),
    };
    app.locals.wsManager = mockWsManager;

    const proj1 = await pool.query(
      `INSERT INTO projects (organization_id, name, slug, visibility, created_by)
       VALUES ($1, 'H15 Private Project', $2, 'private', $3) RETURNING id`,
      [ORG_ID, `h15-private-${Date.now()}`, ALICE]
    );
    privateProjectId = proj1.rows[0].id;

    const proj2 = await pool.query(
      `INSERT INTO projects (organization_id, name, slug, visibility, created_by)
       VALUES ($1, 'H15 Other Project', $2, 'private', $3) RETURNING id`,
      [ORG_ID, `h15-other-${Date.now()}`, ALICE]
    );
    otherProjectId = proj2.rows[0].id;

    // Alice is a member of BOTH projects; Bob is a member of neither.
    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'member'), ($3, $2, 'member')`,
      [privateProjectId, ALICE, otherProjectId]
    );

    const f1 = await pool.query(
      `INSERT INTO datasets (organization_id, filename, file_type, uploaded_by, status)
       VALUES ($1, 'h15-with-project.vtp', 'vtp', $2, 'active') RETURNING id`,
      [ORG_ID, ALICE]
    );
    fileWithProjectId = f1.rows[0].id;
    await pool.query(
      `INSERT INTO file_project_access (file_id, project_id, added_by) VALUES ($1, $2, $3)`,
      [fileWithProjectId, privateProjectId, ALICE]
    );

    const f2 = await pool.query(
      `INSERT INTO datasets (organization_id, filename, file_type, uploaded_by, status)
       VALUES ($1, 'h15-no-project.vtp', 'vtp', $2, 'active') RETURNING id`,
      [ORG_ID, ALICE]
    );
    fileNoProjectId = f2.rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM annotations WHERE id = ANY($1::uuid[])', [createdAnnotationIds]);
    await pool.query('DELETE FROM file_project_access WHERE file_id = ANY($1::uuid[])', [
      [fileWithProjectId, fileNoProjectId],
    ]);
    await pool.query('DELETE FROM datasets WHERE id = ANY($1::uuid[])', [
      [fileWithProjectId, fileNoProjectId],
    ]);
    await pool.query('DELETE FROM project_members WHERE project_id = ANY($1::uuid[])', [
      [privateProjectId, otherProjectId],
    ]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [
      [privateProjectId, otherProjectId],
    ]);
    await pool.end();
  });

  beforeEach(() => {
    mockWsManager.annotationCreated.mockClear();
  });

  test('a project member can create an annotation with projectId omitted (the VR case)', async () => {
    const res = await request(app)
      .post('/api/annotations')
      .set(authHeaders(ALICE))
      .send({ fileId: fileWithProjectId, type: 'note', coordinates: [1, 2, 3] });

    expect(res.status).toBe(201);
    createdAnnotationIds.push(res.body.annotation.id);
  });

  test('a non-member cannot create an annotation even with projectId omitted (H15 bug)', async () => {
    const res = await request(app)
      .post('/api/annotations')
      .set(authHeaders(BOB))
      .send({ fileId: fileWithProjectId, type: 'note', coordinates: [1, 2, 3] });

    expect(res.status).toBe(403);
  });

  test('a non-member cannot bypass the check by supplying an unrelated projectId', async () => {
    const res = await request(app)
      .post('/api/annotations')
      .set(authHeaders(BOB))
      .send({
        fileId: fileWithProjectId,
        type: 'note',
        coordinates: [1, 2, 3],
        projectId: otherProjectId, // Bob isn't a member of this one either, but it proves the body value isn't what's checked
      });

    expect(res.status).toBe(403);
  });

  test('a file with no project association: the uploader can annotate it', async () => {
    const res = await request(app)
      .post('/api/annotations')
      .set(authHeaders(ALICE))
      .send({ fileId: fileNoProjectId, type: 'note', coordinates: [1, 2, 3] });

    expect(res.status).toBe(201);
    createdAnnotationIds.push(res.body.annotation.id);
  });

  test('a file with no project association: a non-owner cannot annotate it', async () => {
    const res = await request(app)
      .post('/api/annotations')
      .set(authHeaders(BOB))
      .send({ fileId: fileNoProjectId, type: 'note', coordinates: [1, 2, 3] });

    expect(res.status).toBe(403);
  });

  test('broadcast never reaches a spoofed, unrelated projectId supplied in the body', async () => {
    const res = await request(app)
      .post('/api/annotations')
      .set(authHeaders(ALICE))
      .send({
        fileId: fileWithProjectId,
        type: 'note',
        coordinates: [4, 5, 6],
        projectId: otherProjectId, // Alice IS a member of this, but it has no relation to the file
      });

    expect(res.status).toBe(201);
    createdAnnotationIds.push(res.body.annotation.id);

    const broadcastProjectIds = mockWsManager.annotationCreated.mock.calls.map((c) => c[0]);
    expect(broadcastProjectIds).toContain(privateProjectId);
    expect(broadcastProjectIds).not.toContain(otherProjectId);
  });

  describe('POST /api/annotations/batch', () => {
    test('creates the authorized item and skips the unauthorized one', async () => {
      const res = await request(app)
        .post('/api/annotations/batch')
        .set(authHeaders(BOB))
        .send({
          annotations: [
            // Bob is not authorized for fileWithProjectId (private, Bob not a member)
            { fileId: fileWithProjectId, type: 'note', coordinates: [1, 1, 1] },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.created).toBe(0);
      expect(res.body.skipped).toBe(1);
    });

    test('a member gets their item created', async () => {
      const res = await request(app)
        .post('/api/annotations/batch')
        .set(authHeaders(ALICE))
        .send({
          annotations: [
            { fileId: fileWithProjectId, type: 'note', coordinates: [2, 2, 2] },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.created).toBe(1);
      createdAnnotationIds.push(res.body.annotations[0].id);
    });
  });
});
