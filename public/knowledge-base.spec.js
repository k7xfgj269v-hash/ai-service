const fs = require('fs');
const path = require('path');
const {
  ADMIN_KEY_STORAGE,
  MAX_FILE_SIZE,
  parseTags,
  validateFile,
  normalizeDocument,
  createAdminHeaders,
  extractDocuments,
  errorMessage,
} = require('./knowledge-base');

describe('knowledge base UI helpers', () => {
  test('parses comma-separated tags, trims values, and removes duplicates', () => {
    expect(parseTags(' HR, Onboarding,hr, , Richtlinie ')).toEqual([
      'HR',
      'Onboarding',
      'Richtlinie',
    ]);
  });

  test.each(['handbook.pdf', 'notes.DOCX', 'policy.md', 'faq.txt'])(
    'accepts supported file %s',
    name => {
      expect(validateFile({ name, size: MAX_FILE_SIZE })).toEqual({
        valid: true,
        error: '',
      });
    },
  );

  test('rejects missing, unsupported, and oversized files', () => {
    expect(validateFile(null).valid).toBe(false);
    expect(validateFile({ name: 'archive.zip', size: 12 }).error).toMatch(/Erlaubt/);
    expect(validateFile({ name: 'large.pdf', size: MAX_FILE_SIZE + 1 }).error).toMatch(/25 MB/);
  });

  test('normalizes document responses without interpreting document text', () => {
    const maliciousName = '<img src=x onerror=alert(1)>';
    expect(normalizeDocument({
      documentId: 'doc-1',
      name: maliciousName,
      tags: 'HR, intern',
      chunkCount: '7',
    })).toEqual({
      id: 'doc-1',
      fileName: maliciousName,
      fileType: 'Datei',
      uploadDate: '',
      chunkCount: 7,
      category: 'Allgemein',
      tags: ['HR', 'intern'],
    });
  });

  test('supports current array and forward-compatible wrapped list responses', () => {
    expect(extractDocuments([{ id: 'a', fileName: 'a.txt' }])).toHaveLength(1);
    expect(extractDocuments({ documents: [{ id: 'b', fileName: 'b.md' }] })[0].id).toBe('b');
    expect(extractDocuments({ unexpected: true })).toEqual([]);
  });

  test('creates the required admin header without persisting or changing the key', () => {
    expect(ADMIN_KEY_STORAGE).toBe('kb_admin_key');
    expect(createAdminHeaders(' session-secret ', 'application/json')).toEqual({
      'x-admin-key': ' session-secret ',
      'Content-Type': 'application/json',
    });
  });

  test('maps authentication and server failures to concise German messages', () => {
    expect(errorMessage({ status: 401 })).toMatch(/Admin-Schlüssel/);
    expect(errorMessage({ status: 500 })).toMatch(/Server/);
    expect(errorMessage({ name: 'TypeError' })).toMatch(/nicht erreichbar/);
  });
});

describe('knowledge base static integration', () => {
  const script = fs.readFileSync(path.join(__dirname, 'knowledge-base.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

  test('keeps the admin key session-only and renders dynamic values as text', () => {
    expect(script).toContain('sessionStorage');
    expect(script).not.toContain('localStorage');
    expect(script).not.toContain('innerHTML');
    expect(script).toContain('textContent');
  });

  test('integrates the knowledge view while keeping chat as the default view', () => {
    expect(html).toMatch(/class="app-view active" id="chatView"/);
    expect(html).toContain('id="knowledgeView"');
    expect(html).toContain('id="knowledgeNavButton"');
    expect(html).toContain('<script src="knowledge-base.js"></script>');
  });

  test('declares all supported picker formats and required operation states', () => {
    expect(html).toContain('.pdf,.docx,.md,.txt');
    expect(script).toContain("setBusy('uploading')");
    expect(script).toContain("setBusy('rebuilding')");
    expect(script).toContain("setBusy('deleting')");
    expect(script).toContain("setListState('loading'");
    expect(script).toContain("setListState('empty'");
    expect(script).toContain("setListState('error'");
  });
});
