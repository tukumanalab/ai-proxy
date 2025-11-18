import Database from 'better-sqlite3';
import path from 'path';

export interface RequestLog {
  id?: number;
  timestamp: string;
  method: string;
  path: string;
  headers: string;
  query: string;
  requestBody: string;
  statusCode?: number;
  responseHeaders?: string;
  responseBody?: string;
  duration?: number;
  error?: string;
}

export interface NGWord {
  id?: number;
  word: string;
  created_at?: string;
}

class DatabaseService {
  private db: Database.Database;

  constructor() {
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'proxy.db');
    this.db = new Database(dbPath);
    this.initDatabase();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        headers TEXT,
        query TEXT,
        requestBody TEXT,
        statusCode INTEGER,
        responseHeaders TEXT,
        responseBody TEXT,
        duration INTEGER,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for faster queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_timestamp ON request_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_method ON request_logs(method);
      CREATE INDEX IF NOT EXISTS idx_path ON request_logs(path);
    `);

    // Create ng_words table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ng_words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        word TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migrate NG words from environment variable if table is empty
    this.migrateNGWordsFromEnv();
  }

  private migrateNGWordsFromEnv() {
    const count = this.db.prepare('SELECT COUNT(*) as count FROM ng_words').get() as { count: number };

    if (count.count === 0) {
      const ngWordsEnv = process.env.NG_WORDS || '';
      const words = ngWordsEnv
        .split(',')
        .map(word => word.trim())
        .filter(word => word.length > 0);

      if (words.length > 0) {
        const stmt = this.db.prepare('INSERT OR IGNORE INTO ng_words (word) VALUES (?)');
        for (const word of words) {
          stmt.run(word);
        }
        console.log(`Migrated ${words.length} NG words from environment variable to database`);
      }
    }
  }

  insertRequest(log: RequestLog): number {
    const stmt = this.db.prepare(`
      INSERT INTO request_logs (
        timestamp, method, path, headers, query, requestBody,
        statusCode, responseHeaders, responseBody, duration, error
      ) VALUES (
        @timestamp, @method, @path, @headers, @query, @requestBody,
        @statusCode, @responseHeaders, @responseBody, @duration, @error
      )
    `);

    const result = stmt.run({
      timestamp: log.timestamp,
      method: log.method,
      path: log.path,
      headers: log.headers,
      query: log.query,
      requestBody: log.requestBody,
      statusCode: log.statusCode || null,
      responseHeaders: log.responseHeaders || null,
      responseBody: log.responseBody || null,
      duration: log.duration || null,
      error: log.error || null
    });

    return result.lastInsertRowid as number;
  }

  updateResponse(id: number, response: Partial<RequestLog>) {
    const stmt = this.db.prepare(`
      UPDATE request_logs
      SET statusCode = @statusCode,
          responseHeaders = @responseHeaders,
          responseBody = @responseBody,
          duration = @duration,
          error = @error
      WHERE id = @id
    `);

    stmt.run({
      id,
      statusCode: response.statusCode || null,
      responseHeaders: response.responseHeaders || null,
      responseBody: response.responseBody || null,
      duration: response.duration || null,
      error: response.error || null
    });
  }

  getAllRequests(limit: number = 100, offset: number = 0): RequestLog[] {
    const stmt = this.db.prepare(`
      SELECT * FROM request_logs
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `);

    return stmt.all(limit, offset) as RequestLog[];
  }

  getRequestById(id: number): RequestLog | undefined {
    const stmt = this.db.prepare('SELECT * FROM request_logs WHERE id = ?');
    return stmt.get(id) as RequestLog | undefined;
  }

  getTotalCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM request_logs');
    const result = stmt.get() as { count: number };
    return result.count;
  }

  deleteOldRequests(daysOld: number = 30) {
    const stmt = this.db.prepare(`
      DELETE FROM request_logs
      WHERE datetime(created_at) < datetime('now', '-' || ? || ' days')
    `);
    const result = stmt.run(daysOld);
    return result.changes;
  }

  // NG Words CRUD methods
  getAllNGWords(): NGWord[] {
    const stmt = this.db.prepare('SELECT * FROM ng_words ORDER BY id ASC');
    return stmt.all() as NGWord[];
  }

  getNGWordById(id: number): NGWord | undefined {
    const stmt = this.db.prepare('SELECT * FROM ng_words WHERE id = ?');
    return stmt.get(id) as NGWord | undefined;
  }

  addNGWord(word: string): number {
    const stmt = this.db.prepare('INSERT INTO ng_words (word) VALUES (?)');
    const result = stmt.run(word.trim());
    return result.lastInsertRowid as number;
  }

  updateNGWord(id: number, word: string): boolean {
    const stmt = this.db.prepare('UPDATE ng_words SET word = ? WHERE id = ?');
    const result = stmt.run(word.trim(), id);
    return result.changes > 0;
  }

  deleteNGWord(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM ng_words WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  close() {
    this.db.close();
  }
}

export const db = new DatabaseService();
