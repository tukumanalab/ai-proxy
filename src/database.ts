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

  close() {
    this.db.close();
  }
}

export const db = new DatabaseService();
