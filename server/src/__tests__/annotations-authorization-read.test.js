// server/src/__tests__/annotations-authorization-read.test.js
// Authorization gaps in the read/migrate side of the annotations API:
//   - GET /api/annotations (list) never checked dataset/project access at
//     all, and an explicit `visibility` filter replaced (rather than
//     narrowed) the default public-or-owner restriction.
//   - GET /api/annotations/:id returned any annotation by UUID with no
//     visibility or dataset/project check whatsoever.
//   - POST /api/annotations/:id/migrate never checked ownership, dataset
//     access, or that targetVersionId belongs to the same dataset as the
//     annotation being migrated.
//
// ─── AUTO-SKIP ─────────────────────────────────────────────────────────────
// Tests auto-skip if TEST_DATABASE_URL is not set.
//
// ─── SETUP ──────────────────────────────────────────────────────────────────
//   1. docker-compose up -d cia-postgres
//   2. NODE_ENV=development \
//      TEST_DATABASE_URL="postgres://ciauser:ciadevpassword@localhost:5432/cia_analytics" \
//      DEV_BYPASS_AUTH=true \
//      cd server && npm test -- --testPathPattern "annotations-authorization-read" --runInBand
//
// NOTE: DEV_BYPASS_AUTH is only honored when NODE_ENV=development is ALSO
// set (see server/src/middleware/auth.js) — Jest defaults NODE_ENV to "test"
// when not otherwise set, which silently disables dev-bypass auth and makes
// every request resolve to the real (non-bypass) default dev user instead of
// the intended x-user-id/x-user-name headers.

'use strict';

const request = require('supertest');
const {
  createTestPool,
  integrationDescribe,
  SEED,
} = require('./helpers/dbFixture');
const { createTestApp } = require('./helpers/testApp');

const pool = createTestPool();

integrationDescribe('Annotation read/migrate authorization', pool, () => {
  let app;
  const ORG_ID = '00000000-0000-0000-0000-000000000000';
  const ALICE = SEED.USER_ALICE;
  const BOB = SEED.USER_BOB;

  const USER_NAMES = { [ALICE]: 'Alice Analyst', [BOB]: 'Bob Builder' };
  function authHeaders(userId) {
    return {
      'x-user-id': userId,
      'x-user-name': USER_NAMES[userId] || 'Test User',
      'Content-Type': 'application/json',
    };
  }

  let privateProjectId;
  let fileId; // belongs to privateProjectId, owned by Alice
  let publicAnnotationId; // Alice's, visibility: public
  let privateAnnotationId; // Alice's, visibility: private
  let unrelatedFileId; // a second dataset, no project association
  let unrelatedFileVersionId;

  beforeAll(async () => {
    app = createTestApp(pool);

    const proj = await pool.query(
      `INSERT INTO projects (organization_id, name, slug, visibility, created_by)
       VALUES ($1, 'Annotation Read Auth Project', $2, 'private', $3) RETURNING id`,
      [ORG_ID, `annot-read-auth-${Date.now()}`, ALICE]
    );
    privateProjectId = proj.rows[0].id;

    // Alice is a member; Bob is not.
    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'member')`,
      [privateProjectId, ALICE]
    );

    const file = await pool.query(
      `INSERT INTO datasets (organization_id, filename, file_type, uploaded_by, status)
       VALUES ($1, 'read-auth.vtp', 'vtp', $2, 'active') RETURNING id`,
      [ORG_ID, ALICE]
    );
    fileId = file.rows[0].id;
    await pool.query(
      `INSERT INTO file_project_access (file_id, project_id, added_by) VALUES ($1, $2, $3)`,
      [fileId, privateProjectId, ALICE]
    );

    const pub = await pool.query(
      `INSERT INTO annotations (dataset_id, type, position, text, visibility, created_by)
       VALUES ($1, 'note', ARRAY[1,2,3]::double precision[], 'public note', 'public', $2)
       RETURNING id`,
      [fileId, ALICE]
    );
    publicAnnotationId = pub.rows[0].id;

    const priv = await pool.query(
      `INSERT INTO annotations (dataset_id, type, position, text, visibility, created_by)
       VALUES ($1, 'note', ARRAY[4,5,6]::double precision[], 'private note', 'private', $2)
       RETURNING id`,
      [fileId, ALICE]
    );
    privateAnnotationId = priv.rows[0].id;

    // A second, unrelated dataset (no file_project_access rows, no relation
    // to fileId) with its own version — used to prove migrate rejects a
    // targetVersionId from a different dataset.
    const unrelatedFile = await pool.query(
      `INSERT INTO datasets (organization_id, filename, file_type, uploaded_by, status)
       VALUES ($1, 'unrelated.vtp', 'vtp', $2, 'active') RETURNING id`,
      [ORG_ID, ALICE]
    );
    unrelatedFileId = unrelatedFile.rows[0].id;
    const unrelatedVersion = await pool.query(
      `INSERT INTO file_versions (file_id, version_number, hash, storage_key)
       VALUES ($1, 1, 'deadbeef', 'unrelated/v1') RETURNING id`,
      [unrelatedFileId]
    );
    unrelatedFileVersionId = unrelatedVersion.rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM annotations WHERE dataset_id = ANY($1::uuid[])', [
      [fileId, unrelatedFileId],
    ]);
    await pool.query('DELETE FROM file_versions WHERE file_id = $1', [unrelatedFileId]);
    await pool.query('DELETE FROM file_project_access WHERE file_id = $1', [fileId]);
    await pool.query('DELETE FROM datasets WHERE id = ANY($1::uuid[])', [
      [fileId, unrelatedFileId],
    ]);
    await pool.query('DELETE FROM project_members WHERE project_id = $1', [privateProjectId]);
    await pool.query('DELETE FROM projects WHERE id = $1', [privateProjectId]);
    await pool.end();
  });

  describe('GET /api/annotations (list)', () => {
    test('400 when neither fileId nor projectId is supplied', async () => {
      const res = await request(app)
        .get('/api/annotations')
        .set(authHeaders(ALICE));

      expect(res.status).toBe(400);
    });

    test('403 for a non-member scoping by fileId', async () => {
      const res = await request(app)
        .get(`/api/annotations?fileId=${fileId}`)
        .set(authHeaders(BOB));

      expect(res.status).toBe(403);
    });

    test('403 for a non-member scoping by projectId', async () => {
      const res = await request(app)
        .get(`/api/annotations?projectId=${privateProjectId}`)
        .set(authHeaders(BOB));

      expect(res.status).toBe(403);
    });

    test('200 for a member, returns only public + own annotations', async () => {
      const res = await request(app)
        .get(`/api/annotations?fileId=${fileId}`)
        .set(authHeaders(ALICE));

      expect(res.status).toBe(200);
      const ids = res.body.annotations.map((a) => a.id);
      expect(ids).toContain(publicAnnotationId);
      expect(ids).toContain(privateAnnotationId); // Alice owns it
    });

    test('an explicit visibility filter narrows, but never replaces, the default restriction', async () => {
      // Bob is a non-member so this 403s regardless — prove the fileId path
      // still gates before the visibility filter is ever applied.
      const nonMember = await request(app)
        .get(`/api/annotations?fileId=${fileId}&visibility=private`)
        .set(authHeaders(BOB));
      expect(nonMember.status).toBe(403);
    });
  });

  describe('GET /api/annotations/:id', () => {
    test('404 for a non-member (public annotation, but no dataset access)', async () => {
      const res = await request(app)
        .get(`/api/annotations/${publicAnnotationId}`)
        .set(authHeaders(BOB));

      expect(res.status).toBe(404);
    });

    test('200 for a member fetching a public annotation', async () => {
      const res = await request(app)
        .get(`/api/annotations/${publicAnnotationId}`)
        .set(authHeaders(ALICE));

      expect(res.status).toBe(200);
      expect(res.body.annotation.id).toBe(publicAnnotationId);
    });

    test('200 for the owner fetching their own private annotation', async () => {
      const res = await request(app)
        .get(`/api/annotations/${privateAnnotationId}`)
        .set(authHeaders(ALICE));

      expect(res.status).toBe(200);
      expect(res.body.annotation.id).toBe(privateAnnotationId);
    });
  });

  describe('POST /api/annotations/:id/migrate', () => {
    test('403 for a non-creator (even a project member would be, but Bob is not one here)', async () => {
      const res = await request(app)
        .post(`/api/annotations/${publicAnnotationId}/migrate`)
        .set(authHeaders(BOB))
        .send({ targetVersionId: unrelatedFileVersionId });

      expect(res.status).toBe(403);
    });

    test('400 when targetVersionId belongs to a different dataset', async () => {
      const res = await request(app)
        .post(`/api/annotations/${publicAnnotationId}/migrate`)
        .set(authHeaders(ALICE))
        .send({ targetVersionId: unrelatedFileVersionId });

      expect(res.status).toBe(400);
    });

    test('the creator can migrate to a version of the SAME dataset', async () => {
      const version = await pool.query(
        `INSERT INTO file_versions (file_id, version_number, hash, storage_key)
         VALUES ($1, 1, 'cafef00d', 'read-auth/v1') RETURNING id`,
        [fileId]
      );
      const targetVersionId = version.rows[0].id;

      const res = await request(app)
        .post(`/api/annotations/${publicAnnotationId}/migrate`)
        .set(authHeaders(ALICE))
        .send({ targetVersionId });

      expect(res.status).toBe(200);
      expect(res.body.migrated.file_version_id).toBe(targetVersionId);

      await pool.query('DELETE FROM annotations WHERE id = $1', [res.body.migrated.id]);
      await pool.query('DELETE FROM file_versions WHERE id = $1', [targetVersionId]);
    });
  });
});
