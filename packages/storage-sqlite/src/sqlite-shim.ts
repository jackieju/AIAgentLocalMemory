const isBun = typeof (globalThis as any).Bun !== "undefined";

let DatabaseImpl: any;
if (isBun) {
  DatabaseImpl = require("bun:sqlite").Database;
} else {
  DatabaseImpl = require("node:sqlite").DatabaseSync;
}

export class Database {
  private db: any;
  private _isBun = isBun;

  constructor(path: string, _opts?: { create?: boolean }) {
    if (this._isBun) {
      this.db = new DatabaseImpl(path, _opts);
    } else {
      this.db = new DatabaseImpl(path);
    }
    this.exec("PRAGMA journal_mode = WAL");
    this.exec("PRAGMA busy_timeout = 5000");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql), this._isBun);
  }

  close(): void {
    this.db.close();
  }
}

export class Statement {
  private stmt: any;
  private _isBun: boolean;

  constructor(stmt: any, isBun: boolean) {
    this.stmt = stmt;
    this._isBun = isBun;
  }

  run(...params: any[]): any {
    if (this._isBun) {
      return this.stmt.run(...params);
    }
    return this.stmt.run(...params);
  }

  get(...params: any[]): any {
    if (this._isBun) {
      return this.stmt.get(...params);
    }
    return this.stmt.get(...params);
  }

  all(...params: any[]): any[] {
    if (this._isBun) {
      return this.stmt.all(...params);
    }
    return this.stmt.all(...params);
  }

  finalize(): void {
    if (typeof this.stmt.finalize === "function") {
      this.stmt.finalize();
    }
  }
}
