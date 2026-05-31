/**
 * WeFlow API CLI - WCDB Core (macOS)
 *
 * Compatible facade for the original wcdbCore API:
 * - Keeps the same method signatures used by httpService/wsService
 * - Replaces Windows DLL calls with macOS decrypt + sqlite workflow
 */
import { createDecipheriv, createHash, createHmac, pbkdf2Sync, timingSafeEqual } from 'crypto';
import Database from 'better-sqlite3';
import {
    appendFileSync,
    existsSync,
    FSWatcher,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    watch,
} from 'fs';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import { copyFile, mkdir, rename, writeFile } from 'fs/promises';
import { getConfig } from '../../config.js';
import { WcdbDll } from './wcdbDll.js';

interface WcdbResult<T = any> {
    success: boolean;
    data?: T;
    error?: string;
}

interface ResolvedDataRoot {
    sourceRoot: string;
    version: 3 | 4;
    sessionDbPath: string;
}

interface MessageDbInfo {
    path: string;
    startTs: number;
    endTs: number;
}

interface MessageCursor {
    id: number;
    sessionId: string;
    batchSize: number;
    ascending: boolean;
    beginTimestamp: number;
    endTimestamp: number;
    offset: number;
}

interface RoomUser {
    userName: string;
    displayName?: string;
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary');
const SQLITE_HEADER_LEN = 16;
const KEY_SIZE = 32;

const V4_PAGE_SIZE = 4096;
const V4_HMAC_SIZE = 64;
const V4_RESERVE = 80;
const V4_ITER = 256000;

const V3_PAGE_SIZE = 1024;
const V3_HMAC_SIZE = 20;
const V3_RESERVE = 48;

function ensureDirSync(path: string): void {
    if (!existsSync(path)) {
        mkdirSync(path, { recursive: true });
    }
}

function toHexKey(hexKey: string): Buffer {
    const clean = (hexKey || '').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
        throw new Error('Invalid DECRYPT_KEY, expected 64 hex chars');
    }
    return Buffer.from(clean, 'hex');
}

function xorBytes(input: Buffer, value: number): Buffer {
    const out = Buffer.allocUnsafe(input.length);
    for (let i = 0; i < input.length; i++) {
        out[i] = input[i] ^ value;
    }
    return out;
}

function isAllZero(buf: Buffer): boolean {
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 0) return false;
    }
    return true;
}

function decodeVarint(buf: Buffer, start: number): { value: number; offset: number } {
    let value = 0;
    let shift = 0;
    let offset = start;

    while (offset < buf.length) {
        const b = buf[offset];
        value |= (b & 0x7f) << shift;
        offset += 1;
        if ((b & 0x80) === 0) {
            return { value, offset };
        }
        shift += 7;
        if (shift > 53) {
            throw new Error('Varint too large');
        }
    }

    throw new Error('Unexpected EOF while decoding varint');
}

function skipUnknownField(buf: Buffer, wireType: number, offset: number): number {
    switch (wireType) {
        case 0: {
            return decodeVarint(buf, offset).offset;
        }
        case 1:
            return offset + 8;
        case 2: {
            const lengthVar = decodeVarint(buf, offset);
            return lengthVar.offset + lengthVar.value;
        }
        case 5:
            return offset + 4;
        default:
            throw new Error(`Unsupported wire type: ${wireType}`);
    }
}

function parseRoomUser(buf: Buffer): RoomUser | null {
    let offset = 0;
    let userName = '';
    let displayName = '';

    while (offset < buf.length) {
        const tag = decodeVarint(buf, offset);
        offset = tag.offset;

        const fieldNo = tag.value >> 3;
        const wireType = tag.value & 0x07;

        if (wireType !== 2) {
            offset = skipUnknownField(buf, wireType, offset);
            continue;
        }

        const lenVar = decodeVarint(buf, offset);
        offset = lenVar.offset;
        const end = offset + lenVar.value;
        if (end > buf.length) break;

        const val = buf.subarray(offset, end).toString('utf8');
        offset = end;

        if (fieldNo === 1) {
            userName = val;
        } else if (fieldNo === 2) {
            displayName = val;
        }
    }

    if (!userName) return null;
    return displayName ? { userName, displayName } : { userName };
}

function parseRoomData(extBuffer: Buffer | null | undefined): RoomUser[] {
    if (!extBuffer || extBuffer.length === 0) return [];

    const users: RoomUser[] = [];
    let offset = 0;

    while (offset < extBuffer.length) {
        const tag = decodeVarint(extBuffer, offset);
        offset = tag.offset;

        const fieldNo = tag.value >> 3;
        const wireType = tag.value & 0x07;

        if (fieldNo === 1 && wireType === 2) {
            const lenVar = decodeVarint(extBuffer, offset);
            offset = lenVar.offset;
            const end = offset + lenVar.value;
            if (end > extBuffer.length) break;

            const userBuf = extBuffer.subarray(offset, end);
            offset = end;
            const user = parseRoomUser(userBuf);
            if (user) users.push(user);
            continue;
        }

        offset = skipUnknownField(extBuffer, wireType, offset);
    }

    return users;
}

function md5Text(text: string): string {
    return createHash('md5').update(text).digest('hex');
}

function normalizeSqlValue(value: any): any {
    if (value === null || value === undefined) return value;
    if (Buffer.isBuffer(value)) return value.toString('hex');
    if (typeof value === 'bigint') return value.toString();
    return value;
}

function normalizeSqlRow(row: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
        out[key] = normalizeSqlValue(value);
    }
    return out;
}

function toUnixMTimeKey(path: string): string {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
}

function compareBySortSeq(a: any, b: any, asc: boolean): number {
    const sa = Number(a.sort_seq || 0);
    const sb = Number(b.sort_seq || 0);
    if (sa !== sb) return asc ? sa - sb : sb - sa;

    const la = Number(a.local_id || 0);
    const lb = Number(b.local_id || 0);
    return asc ? la - lb : lb - la;
}

export class WcdbCore {
    private logEnabled: boolean;
    private logDir: string;

    private initialized = false;
    private connected = false;

    private currentPath: string | null = null;
    private currentKey: string | null = null;
    private currentWxid: string | null = null;

    private version: 3 | 4 = 4;
    private sourceRoot = '';
    private workRoot = '';

    private keyBytes: Buffer | null = null;

    private fileVersionKey: Map<string, string> = new Map();

    private messageDbInfos: MessageDbInfo[] = [];
    private messageTablesByDb: Map<string, Set<string>> = new Map();

    private dbHandles: Map<string, Database.Database> = new Map();

    private cursors: Map<number, MessageCursor> = new Map();
    private nextCursorId = 1;

    private monitorCallback: ((type: string, json: string) => void) | null = null;
    private monitorWatcher: FSWatcher | null = null;
    private monitorReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private monitorPipeConnected = false;

    // DLL 后端（高性能模式）
    private dll: WcdbDll | null = null;
    private dllMode = false;
    private dllPreferred = false;
    private dllResourcesPath = '';

    // DLL 重连状态（防止多次并发重连）
    private dllReconnectPromise: Promise<boolean> | null = null;
    private lastDllReconnectAt = 0;
    private dllReconnectCooldownMs = 10000; // 重连冷却 10 秒
    private dllRetryTimer: ReturnType<typeof setTimeout> | null = null;
    private dllRetryInFlight = false;
    private readonly dllRetryInitialDelayMs = 5000;
    private readonly dllRetryMaxDelayMs = 60000;
    private dllRetryDelayMs = 5000;

    private syncing = false;
    private lastSyncAt = 0;
    private minSyncIntervalMs = 100;
    private dbWatchEventDebounceMs = 30;

    private opChain: Promise<void> = Promise.resolve();

    constructor() {
        const config = getConfig();
        this.logEnabled = config.logEnabled;
        this.logDir = config.logDir;
        this.minSyncIntervalMs = config.dbSyncMinIntervalMs;
        this.dbWatchEventDebounceMs = config.dbWatchEventDebounceMs;
        this.dllPreferred = config.dllEnabled && !!config.wcdbResourcesPath;
        this.dllResourcesPath = config.wcdbResourcesPath || '';
    }

    private writeLog(message: string, force = false): void {
        if (!force && !this.logEnabled) return;

        const line = `[${new Date().toISOString()}] ${message}`;
        console.log(line);

        try {
            ensureDirSync(this.logDir);
            appendFileSync(join(this.logDir, 'wcdb.log'), `${line}\n`, { encoding: 'utf8' });
        } catch {
            // ignore logging errors
        }
    }

    private runSerialized<T>(fn: () => Promise<T> | T): Promise<T> {
        const run = this.opChain.then(() => fn());
        this.opChain = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    private resolveWorkRoot(sourceRoot: string, wxid: string): string {
        const digest = createHash('md5').update(`${sourceRoot}|${wxid}`).digest('hex').slice(0, 12);
        return resolve(this.logDir, 'decrypted', digest);
    }

    private findSessionDbCandidates(basePath: string): string[] {
        const files: string[] = [];

        const stack = [basePath];
        while (stack.length > 0) {
            const dir = stack.pop()!;
            let entries: string[];
            try {
                entries = readdirSync(dir);
            } catch {
                continue;
            }

            for (const entry of entries) {
                const fullPath = join(dir, entry);
                let st;
                try {
                    st = statSync(fullPath);
                } catch {
                    continue;
                }

                if (st.isDirectory()) {
                    stack.push(fullPath);
                    continue;
                }

                if (!st.isFile()) continue;
                const lower = entry.toLowerCase();
                if (lower === 'session.db' || lower === 'session_new.db') {
                    files.push(fullPath);
                }
            }
        }

        return files;
    }

    private resolveSourceRoot(dbPath: string, wxid: string): ResolvedDataRoot | null {
        const normalized = resolve(dbPath);

        let candidates: string[] = [];

        if (existsSync(normalized)) {
            const st = statSync(normalized);
            if (st.isFile()) {
                const lower = basename(normalized).toLowerCase();
                if (lower === 'session.db' || lower === 'session_new.db') {
                    candidates = [normalized];
                } else {
                    candidates = this.findSessionDbCandidates(dirname(normalized));
                }
            } else if (st.isDirectory()) {
                candidates = this.findSessionDbCandidates(normalized);
            }
        }

        if (candidates.length === 0) {
            return null;
        }

        const scored = candidates.map((path) => {
            const lower = path.toLowerCase();
            const hasWxid = wxid ? lower.includes(wxid.toLowerCase()) : false;
            const isV4 = lower.endsWith('/session/session.db') || lower.endsWith('\\session\\session.db') || basename(lower) === 'session.db';
            const mtime = statSync(path).mtimeMs;
            return { path, hasWxid, isV4, mtime };
        });

        scored.sort((a, b) => {
            if (a.hasWxid !== b.hasWxid) return a.hasWxid ? -1 : 1;
            if (a.isV4 !== b.isV4) return a.isV4 ? -1 : 1;
            return b.mtime - a.mtime;
        });

        const chosen = scored[0].path;
        const lower = basename(chosen).toLowerCase();

        if (lower === 'session.db') {
            const sourceRoot = dirname(dirname(chosen));
            return { sourceRoot, version: 4, sessionDbPath: chosen };
        }

        if (lower === 'session_new.db') {
            const sourceRoot = dirname(chosen);
            return { sourceRoot, version: 3, sessionDbPath: chosen };
        }

        return null;
    }

    private collectDbFiles(): string[] {
        if (!this.sourceRoot) return [];

        const result: string[] = [];
        const stack = [this.sourceRoot];

        while (stack.length > 0) {
            const dir = stack.pop()!;
            let entries: string[];
            try {
                entries = readdirSync(dir);
            } catch {
                continue;
            }

            for (const entry of entries) {
                const fullPath = join(dir, entry);
                let st;
                try {
                    st = statSync(fullPath);
                } catch {
                    continue;
                }

                if (st.isDirectory()) {
                    stack.push(fullPath);
                    continue;
                }

                if (!st.isFile()) continue;
                if (extname(entry).toLowerCase() !== '.db') continue;
                if (entry.toLowerCase().includes('fts')) continue;

                result.push(fullPath);
            }
        }

        result.sort();
        return result;
    }

    private closeDb(path: string): void {
        const db = this.dbHandles.get(path);
        if (!db) return;
        try {
            db.close();
        } catch {
            // ignore close errors
        }
        this.dbHandles.delete(path);
        this.messageTablesByDb.delete(path);
    }

    private closeAllDbs(): void {
        for (const path of Array.from(this.dbHandles.keys())) {
            this.closeDb(path);
        }
    }

    private getDb(path: string): Database.Database {
        const resolvedPath = resolve(path);

        let db = this.dbHandles.get(resolvedPath);
        if (db) return db;

        db = new Database(resolvedPath, {
            readonly: true,
            fileMustExist: true,
        });
        this.dbHandles.set(resolvedPath, db);
        return db;
    }

    private deriveV4Keys(key: Buffer, salt: Buffer): { encKey: Buffer; macKey: Buffer } {
        const encKey = pbkdf2Sync(key, salt, V4_ITER, KEY_SIZE, 'sha512');
        const macSalt = xorBytes(salt, 0x3a);
        const macKey = pbkdf2Sync(encKey, macSalt, 2, KEY_SIZE, 'sha512');
        return { encKey, macKey };
    }

    private deriveV3Keys(key: Buffer, salt: Buffer): { encKey: Buffer; macKey: Buffer } {
        const encKey = key;
        const macSalt = xorBytes(salt, 0x3a);
        const macKey = pbkdf2Sync(encKey, macSalt, 2, KEY_SIZE, 'sha1');
        return { encKey, macKey };
    }

    private validateFirstPage(
        page1: Buffer,
        derive: (key: Buffer, salt: Buffer) => { encKey: Buffer; macKey: Buffer },
        hmacSize: number,
        reserve: number,
        pageSize: number,
        hashAlgo: 'sha1' | 'sha512'
    ): { encKey: Buffer; macKey: Buffer } {
        if (!this.keyBytes) {
            throw new Error('Decrypt key is not loaded');
        }

        if (page1.length < pageSize) {
            throw new Error('Invalid DB file, first page is incomplete');
        }

        const salt = page1.subarray(0, SQLITE_HEADER_LEN);
        const { encKey, macKey } = derive(this.keyBytes, salt);

        const dataEnd = pageSize - reserve + SQLITE_HEADER_LEN;
        const mac = createHmac(hashAlgo, macKey);
        mac.update(page1.subarray(SQLITE_HEADER_LEN, dataEnd));

        const pageNo = Buffer.allocUnsafe(4);
        pageNo.writeUInt32LE(1, 0);
        mac.update(pageNo);

        const calculated = mac.digest();
        const stored = page1.subarray(dataEnd, dataEnd + hmacSize);

        if (stored.length !== hmacSize || !timingSafeEqual(calculated.subarray(0, hmacSize), stored)) {
            throw new Error('Incorrect DECRYPT_KEY or unsupported DB version');
        }

        return { encKey, macKey };
    }

    private decryptPage(
        page: Buffer,
        pageNo: number,
        encKey: Buffer,
        macKey: Buffer,
        hmacSize: number,
        reserve: number,
        pageSize: number,
        hashAlgo: 'sha1' | 'sha512'
    ): Buffer {
        const offset = pageNo === 0 ? SQLITE_HEADER_LEN : 0;

        const mac = createHmac(hashAlgo, macKey);
        mac.update(page.subarray(offset, pageSize - reserve + SQLITE_HEADER_LEN));

        const pageNoBuf = Buffer.allocUnsafe(4);
        pageNoBuf.writeUInt32LE(pageNo + 1, 0);
        mac.update(pageNoBuf);

        const calculated = mac.digest();
        const hmacStart = pageSize - reserve + SQLITE_HEADER_LEN;
        const stored = page.subarray(hmacStart, hmacStart + hmacSize);

        if (stored.length !== hmacSize || !timingSafeEqual(calculated.subarray(0, hmacSize), stored)) {
            throw new Error(`Hash verification failed at page ${pageNo + 1}`);
        }

        const ivStart = pageSize - reserve;
        const iv = page.subarray(ivStart, ivStart + SQLITE_HEADER_LEN);

        const encrypted = Buffer.from(page.subarray(offset, pageSize - reserve));
        const decipher = createDecipheriv('aes-256-cbc', encKey, iv);
        decipher.setAutoPadding(false);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

        return Buffer.concat([decrypted, page.subarray(pageSize - reserve)]);
    }

    private decryptDbBufferV4(input: Buffer): Buffer {
        const pageCount = Math.floor(input.length / V4_PAGE_SIZE);
        if (pageCount <= 0) {
            throw new Error('Invalid DB file size');
        }

        const firstPage = input.subarray(0, V4_PAGE_SIZE);
        const { encKey, macKey } = this.validateFirstPage(
            firstPage,
            (key, salt) => this.deriveV4Keys(key, salt),
            V4_HMAC_SIZE,
            V4_RESERVE,
            V4_PAGE_SIZE,
            'sha512'
        );

        const out: Buffer[] = [SQLITE_HEADER];

        for (let pageNo = 0; pageNo < pageCount; pageNo++) {
            const page = input.subarray(pageNo * V4_PAGE_SIZE, (pageNo + 1) * V4_PAGE_SIZE);
            if (isAllZero(page)) {
                if (pageNo === 0) {
                    out.push(page.subarray(SQLITE_HEADER_LEN));
                } else {
                    out.push(page);
                }
                continue;
            }

            const decrypted = this.decryptPage(page, pageNo, encKey, macKey, V4_HMAC_SIZE, V4_RESERVE, V4_PAGE_SIZE, 'sha512');
            if (pageNo === 0) {
                out.push(decrypted);
            } else {
                out.push(decrypted);
            }
        }

        return Buffer.concat(out);
    }

    private decryptDbBufferV3(input: Buffer): Buffer {
        const pageCount = Math.floor(input.length / V3_PAGE_SIZE);
        if (pageCount <= 0) {
            throw new Error('Invalid DB file size');
        }

        const firstPage = input.subarray(0, V3_PAGE_SIZE);
        const { encKey, macKey } = this.validateFirstPage(
            firstPage,
            (key, salt) => this.deriveV3Keys(key, salt),
            V3_HMAC_SIZE,
            V3_RESERVE,
            V3_PAGE_SIZE,
            'sha1'
        );

        const out: Buffer[] = [SQLITE_HEADER];

        for (let pageNo = 0; pageNo < pageCount; pageNo++) {
            const page = input.subarray(pageNo * V3_PAGE_SIZE, (pageNo + 1) * V3_PAGE_SIZE);
            if (isAllZero(page)) {
                if (pageNo === 0) {
                    out.push(page.subarray(SQLITE_HEADER_LEN));
                } else {
                    out.push(page);
                }
                continue;
            }

            const decrypted = this.decryptPage(page, pageNo, encKey, macKey, V3_HMAC_SIZE, V3_RESERVE, V3_PAGE_SIZE, 'sha1');
            if (pageNo === 0) {
                out.push(decrypted);
            } else {
                out.push(decrypted);
            }
        }

        return Buffer.concat(out);
    }

    private async decryptOrCopyFile(sourcePath: string, destPath: string): Promise<void> {
        ensureDirSync(dirname(destPath));

        const input = readFileSync(sourcePath);
        if (input.length >= SQLITE_HEADER_LEN && input.subarray(0, SQLITE_HEADER_LEN).equals(SQLITE_HEADER)) {
            await copyFile(sourcePath, destPath);
            return;
        }

        let output: Buffer;
        if (this.version === 4) {
            output = this.decryptDbBufferV4(input);
        } else {
            output = this.decryptDbBufferV3(input);
        }

        const tmpPath = `${destPath}.tmp`;
        await writeFile(tmpPath, output);
        await rename(tmpPath, destPath);
    }

    private async rebuildMessageDbInfos(): Promise<void> {
        this.messageDbInfos = [];

        if (this.version !== 4) return;

        const msgDir = join(this.workRoot, 'message');
        if (!existsSync(msgDir)) return;

        const files = readdirSync(msgDir)
            .filter((name) => /^message_(\d+)?\.db$/i.test(name))
            .map((name) => join(msgDir, name));

        const infos: MessageDbInfo[] = [];
        for (const filePath of files) {
            try {
                const db = this.getDb(filePath);
                const row = db.prepare('SELECT timestamp FROM Timestamp LIMIT 1').get() as { timestamp?: number } | undefined;
                const startTs = Number(row?.timestamp || 0);
                infos.push({ path: filePath, startTs, endTs: Number.MAX_SAFE_INTEGER });
            } catch (e) {
                this.writeLog(`Failed to read Timestamp from ${filePath}: ${e}`);
            }
        }

        infos.sort((a, b) => a.startTs - b.startTs);
        for (let i = 0; i < infos.length; i++) {
            if (i < infos.length - 1) {
                infos[i].endTs = infos[i + 1].startTs;
            } else {
                infos[i].endTs = Number.MAX_SAFE_INTEGER;
            }
        }

        this.messageDbInfos = infos;
    }

    private getCandidateMessageDbs(beginTimestamp: number, endTimestamp: number): string[] {
        if (this.version !== 4) {
            const msgPath = join(this.workRoot, 'message', 'message_0.db');
            return existsSync(msgPath) ? [msgPath] : [];
        }

        if (this.messageDbInfos.length === 0) return [];

        const hasRange = beginTimestamp > 0 || endTimestamp > 0;
        if (!hasRange) {
            return this.messageDbInfos.map((v) => v.path);
        }

        const begin = beginTimestamp > 0 ? beginTimestamp : 0;
        const end = endTimestamp > 0 ? endTimestamp : Number.MAX_SAFE_INTEGER;

        return this.messageDbInfos
            .filter((info) => info.startTs <= end && info.endTs >= begin)
            .map((info) => info.path);
    }

    private ensureMessageTableCache(dbPath: string): Set<string> {
        const cached = this.messageTablesByDb.get(dbPath);
        if (cached) return cached;

        const db = this.getDb(dbPath);
        const rows = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'")
            .all() as Array<{ name: string }>;

        const set = new Set<string>(rows.map((r) => r.name));
        this.messageTablesByDb.set(dbPath, set);
        return set;
    }

    private extractSenderFromContentIfGroup(content: string): string {
        const idx = content.indexOf(':\n');
        if (idx > 0) {
            return content.slice(0, idx).trim();
        }
        return '';
    }

    private messageRowMapper(sessionId: string, row: any): any {
        const contentVal = row.message_content;
        const contentStr = Buffer.isBuffer(contentVal)
            ? contentVal.toString('utf8')
            : typeof contentVal === 'string'
                ? contentVal
                : '';

        const senderFromGroup = sessionId.endsWith('@chatroom') ? this.extractSenderFromContentIfGroup(contentStr) : '';
        const senderRaw = String(row.sender_username || senderFromGroup || '');
        const status = Number(row.status || 0);

        let isSend = 0;
        if (status === 2) isSend = 1;
        if (!sessionId.endsWith('@chatroom') && senderRaw && senderRaw !== sessionId) isSend = 1;
        if (senderRaw && this.currentWxid && senderRaw.toLowerCase() === this.currentWxid.toLowerCase()) isSend = 1;

        return {
            local_id: Number(row.local_id || 0),
            server_id: row.server_id ? String(row.server_id) : '',
            local_type: Number(row.local_type || 1),
            sender_username: senderRaw,
            create_time: Number(row.create_time || 0),
            sort_seq: Number(row.sort_seq || row.create_time || 0),
            status,
            is_send: isSend,
            computed_is_send: isSend,
            message_content: Buffer.isBuffer(row.message_content)
                ? row.message_content.toString('hex')
                : normalizeSqlValue(row.message_content),
            compress_content: Buffer.isBuffer(row.compress_content)
                ? row.compress_content.toString('hex')
                : normalizeSqlValue(row.compress_content),
        };
    }

    private queryMergedMessages(
        sessionId: string,
        beginTimestamp: number,
        endTimestamp: number,
        ascending: boolean,
        requestTopN: number
    ): any[] {
        const sessionHash = md5Text(sessionId);
        const tableName = this.version === 4 ? `Msg_${sessionHash}` : `Chat_${sessionHash}`;

        const dbPaths = this.getCandidateMessageDbs(beginTimestamp, endTimestamp);
        if (dbPaths.length === 0) return [];

        const merged: any[] = [];

        for (const dbPath of dbPaths) {
            let hasTable = true;
            if (this.version === 4) {
                const tables = this.ensureMessageTableCache(dbPath);
                hasTable = tables.has(tableName);
            }
            if (!hasTable) continue;

            const db = this.getDb(dbPath);

            if (this.version === 4) {
                const whereParts: string[] = [];
                const params: any[] = [];

                if (beginTimestamp > 0) {
                    whereParts.push('m.create_time >= ?');
                    params.push(beginTimestamp);
                }
                if (endTimestamp > 0) {
                    whereParts.push('m.create_time <= ?');
                    params.push(endTimestamp);
                }

                const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
                const order = ascending ? 'ASC' : 'DESC';

                const sql = `
                    SELECT
                        m.local_id,
                        m.server_id,
                        m.local_type,
                        n.user_name AS sender_username,
                        m.create_time,
                        m.sort_seq,
                        m.status,
                        m.message_content,
                        m.compress_content
                    FROM ${tableName} m
                    LEFT JOIN Name2Id n ON n.rowid = m.real_sender_id
                    ${whereClause}
                    ORDER BY m.sort_seq ${order}
                    LIMIT ?
                `;

                const rows = db.prepare(sql).all(...params, requestTopN) as any[];
                for (const row of rows) {
                    merged.push(this.messageRowMapper(sessionId, row));
                }
                continue;
            }

            // mac v3 fallback (basic)
            const whereParts: string[] = [];
            const params: any[] = [];
            if (beginTimestamp > 0) {
                whereParts.push('msgCreateTime >= ?');
                params.push(beginTimestamp);
            }
            if (endTimestamp > 0) {
                whereParts.push('msgCreateTime <= ?');
                params.push(endTimestamp);
            }

            const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
            const order = ascending ? 'ASC' : 'DESC';

            const sql = `
                SELECT
                    mesLocalID AS local_id,
                    mesSvrID AS server_id,
                    messageType AS local_type,
                    msgCreateTime AS create_time,
                    msgSeq AS sort_seq,
                    mesDes,
                    msgContent AS message_content,
                    CompressContent AS compress_content
                FROM ${tableName}
                ${whereClause}
                ORDER BY msgCreateTime ${order}
                LIMIT ?
            `;

            try {
                const rows = db.prepare(sql).all(...params, requestTopN) as any[];
                for (const row of rows) {
                    const contentStr = typeof row.message_content === 'string' ? row.message_content : '';
                    const sender = sessionId.endsWith('@chatroom') ? this.extractSenderFromContentIfGroup(contentStr) : (row.mesDes === 0 ? this.currentWxid : sessionId);
                    merged.push({
                        local_id: Number(row.local_id || 0),
                        server_id: row.server_id ? String(row.server_id) : '',
                        local_type: Number(row.local_type || 1),
                        sender_username: sender || '',
                        create_time: Number(row.create_time || 0),
                        sort_seq: Number(row.sort_seq || row.create_time || 0),
                        status: Number(row.mesDes === 0 ? 2 : 4),
                        is_send: Number(row.mesDes === 0 ? 1 : 0),
                        computed_is_send: Number(row.mesDes === 0 ? 1 : 0),
                        message_content: normalizeSqlValue(row.message_content),
                        compress_content: Buffer.isBuffer(row.compress_content)
                            ? row.compress_content.toString('hex')
                            : normalizeSqlValue(row.compress_content),
                    });
                }
            } catch {
                // ignore missing table for v3 shards
            }
        }

        merged.sort((a, b) => compareBySortSeq(a, b, ascending));
        return merged;
    }

    private getSessionDbPath(): string {
        if (this.version === 4) {
            return join(this.workRoot, 'session', 'session.db');
        }
        return join(this.workRoot, 'session_new.db');
    }

    private getContactDbPath(): string {
        if (this.version === 4) {
            return join(this.workRoot, 'contact', 'contact.db');
        }
        return join(this.workRoot, 'wccontact_new2.db');
    }

    private getMediaDbPath(): string {
        if (this.version === 4) {
            return join(this.workRoot, 'media', 'hardlink.db');
        }
        return join(this.workRoot, 'hldata.db');
    }

    private async syncDecryptedData(forceFull: boolean): Promise<void> {
        if (!this.sourceRoot || !this.workRoot) return;
        if (!this.keyBytes) throw new Error('Decrypt key missing');

        if (this.syncing) return;
        this.syncing = true;

        try {
            const sourceFiles = this.collectDbFiles();
            const seen = new Set<string>();

            for (const sourcePath of sourceFiles) {
                const rel = relative(this.sourceRoot, sourcePath);
                const destPath = join(this.workRoot, rel);
                seen.add(sourcePath);

                let changed = forceFull || !existsSync(destPath);
                const versionKey = toUnixMTimeKey(sourcePath);
                const previous = this.fileVersionKey.get(sourcePath);

                if (!changed && previous !== versionKey) {
                    changed = true;
                }

                if (!changed) continue;

                this.closeDb(destPath);
                try {
                    await this.decryptOrCopyFile(sourcePath, destPath);
                    this.fileVersionKey.set(sourcePath, versionKey);
                } catch (e) {
                    const base = basename(sourcePath).toLowerCase();
                    const critical = base === 'session.db' || base === 'contact.db' || base === 'message_0.db' || base === 'session_new.db';
                    this.writeLog(`Decrypt failed for ${sourcePath}: ${e}`, true);
                    if (critical) {
                        throw e;
                    }
                }
            }

            // remove stale tracking
            for (const key of Array.from(this.fileVersionKey.keys())) {
                if (!seen.has(key)) {
                    this.fileVersionKey.delete(key);
                }
            }

            await this.rebuildMessageDbInfos();
            this.lastSyncAt = Date.now();
        } finally {
            this.syncing = false;
        }
    }

    // ========== 新增方法：分层解密支持 messagePushService ==========

    /** 获取源数据根目录 */
    getSourceRoot(): string {
        return this.sourceRoot;
    }

    /** 获取工作目录 */
    getWorkRoot(): string {
        return this.workRoot;
    }

    /** 获取数据库版本 */
    getVersion(): number {
        return this.version;
    }

    /** 获取当前微信ID */
    getMyWxid(): string {
        return this.currentWxid || '';
    }

    /**
     * 只解密 session.db（快速，~10ms）
     * 用于 messagePushService 的 Session 基线比对
     */
    async syncSessionDbOnly(): Promise<void> {
        // DLL 模式：无需解密，DLL 直接读取加密数据库
        if (this.dllMode) return;

        return this.runSerialized(async () => {
            if (!this.sourceRoot || !this.workRoot) return;
            if (!this.keyBytes) throw new Error('Decrypt key missing');

            // 找到 session.db 的源文件
            let sessionSourcePath: string;
            if (this.version === 4) {
                sessionSourcePath = join(this.sourceRoot, 'session', 'session.db');
            } else {
                sessionSourcePath = join(this.sourceRoot, 'session_new.db');
            }

            if (!existsSync(sessionSourcePath)) {
                this.writeLog(`syncSessionDbOnly: session source not found: ${sessionSourcePath}`);
                return;
            }

            const rel = relative(this.sourceRoot, sessionSourcePath);
            const destPath = join(this.workRoot, rel);

            const versionKey = toUnixMTimeKey(sessionSourcePath);
            const previous = this.fileVersionKey.get(sessionSourcePath);

            if (previous === versionKey && existsSync(destPath)) {
                // session.db 未变化，无需重新解密
                return;
            }

            // 关闭旧的 db handle
            this.closeDb(destPath);

            try {
                await this.decryptOrCopyFile(sessionSourcePath, destPath);
                this.fileVersionKey.set(sessionSourcePath, versionKey);
            } catch (e) {
                this.writeLog(`syncSessionDbOnly failed: ${e}`, true);
                throw e;
            }
        });
    }

    private clearDllRetryTimer(): void {
        if (this.dllRetryTimer) {
            clearTimeout(this.dllRetryTimer);
            this.dllRetryTimer = null;
        }
    }

    private stopDllRetryLoop(resetBackoff = true): void {
        this.clearDllRetryTimer();
        if (!this.dllRetryInFlight) {
            this.dllRetryDelayMs = this.dllRetryInitialDelayMs;
        } else if (resetBackoff) {
            this.dllRetryDelayMs = this.dllRetryInitialDelayMs;
        }
    }

    private scheduleDllRetry(reason: string): void {
        if (!this.dllPreferred || !this.dllResourcesPath) return;
        if (this.dllMode) return;
        if (!this.currentPath || !this.currentKey || !this.currentWxid) return;
        if (this.dllRetryTimer || this.dllRetryInFlight) return;

        const delayMs = this.dllRetryDelayMs;
        console.warn(`[WcdbCore] 已回退到 SQLite，${Math.round(delayMs / 1000)} 秒后后台重试 DLL (${reason})`);

        this.dllRetryTimer = setTimeout(() => {
            this.dllRetryTimer = null;
            void this.runDllRetryAttempt(reason);
        }, delayMs);
    }

    private async runDllRetryAttempt(reason: string): Promise<void> {
        if (this.dllRetryInFlight) return;
        if (this.dllMode) return;
        if (!this.dllPreferred || !this.dllResourcesPath) return;
        if (!this.currentPath || !this.currentKey || !this.currentWxid) return;

        this.dllRetryInFlight = true;
        let promoted = false;

        try {
            promoted = await this.tryPromoteToDll(`后台重试: ${reason}`);
        } catch (e) {
            console.error('[WcdbCore] DLL 后台重试异常:', e);
        } finally {
            this.dllRetryInFlight = false;
        }

        if (promoted) {
            this.dllRetryDelayMs = this.dllRetryInitialDelayMs;
            this.clearDllRetryTimer();
            return;
        }

        this.dllRetryDelayMs = Math.min(this.dllRetryMaxDelayMs, this.dllRetryDelayMs * 2);
        this.scheduleDllRetry('上次后台重试失败');
    }

    private async tryPromoteToDll(reason: string): Promise<boolean> {
        return this.runSerialized(async () => {
            if (this.dllMode) return true;
            if (!this.dllPreferred || !this.dllResourcesPath) return false;
            if (!this.currentPath || !this.currentKey || !this.currentWxid) return false;
            if (!WcdbDll.isAvailable(this.dllResourcesPath)) return false;

            try {
                const dll = new WcdbDll();
                const initOk = await dll.initialize(this.dllResourcesPath);
                if (!initOk) return false;

                const openOk = await dll.open(this.currentPath, this.currentKey, this.currentWxid);
                if (!openOk) {
                    dll.shutdown();
                    return false;
                }

                const callback = this.monitorCallback;
                this.stopMonitorInternal(false);

                if (this.dll) {
                    try {
                        this.dll.shutdown();
                    } catch { /* ignore */ }
                }

                this.dll = dll;
                this.dllMode = true;
                this.connected = true;
                this.lastDllReconnectAt = 0;
                this.dllReconnectPromise = null;
                this.dllRetryDelayMs = this.dllRetryInitialDelayMs;

                // DLL 模式不需要 SQLite 句柄，切换后释放可避免额外文件占用。
                this.cursors.clear();
                this.closeAllDbs();
                this.fileVersionKey.clear();
                this.messageDbInfos = [];
                this.messageTablesByDb.clear();

                const resolved = this.resolveSourceRoot(this.currentPath, this.currentWxid);
                if (resolved) {
                    this.sourceRoot = resolved.sourceRoot;
                    this.version = resolved.version;
                }

                if (callback) {
                    const monitorOk = this.startMonitor(callback);
                    if (!monitorOk) {
                        console.warn('[WcdbCore] DLL 恢复后 monitor 重建失败');
                    }
                }

                console.log(`[WcdbCore] ${reason}，DLL 已恢复并切回高性能模式`);
                return true;
            } catch (e) {
                console.error('[WcdbCore] DLL 后台恢复失败:', e);
                return false;
            }
        });
    }

    private async degradeToSqlite(reason: string): Promise<boolean> {
        return this.runSerialized(async () => {
            if (!this.currentPath || !this.currentKey || !this.currentWxid) {
                console.error('[WcdbCore] 无法回退 SQLite：缺少当前连接参数');
                return false;
            }

            if (!this.dllMode && this.connected) {
                this.scheduleDllRetry(reason);
                return true;
            }

            console.warn(`[WcdbCore] DLL 不可用，回退到 SQLite: ${reason}`);

            const callback = this.monitorCallback;
            const sqliteOk = await this.openSqliteBackend(this.currentPath, this.currentKey, this.currentWxid, true, true);
            if (!sqliteOk) {
                console.error('[WcdbCore] 回退 SQLite 失败');
                return false;
            }

            if (callback) {
                const monitorOk = this.startMonitor(callback);
                if (!monitorOk) {
                    console.warn('[WcdbCore] SQLite 回退后 monitor 重建失败');
                }
            }

            this.scheduleDllRetry(reason);
            return true;
        });
    }

    /**
     * 按需解密指定会话对应的 message db 文件
     * 用于 messagePushService 在检测到有变化的会话后，只解密相关的 message db
     */
    async syncMessageDbForSession(sessionId: string, sinceTimestamp?: number): Promise<void> {
        // DLL 模式：无需解密
        if (this.dllMode) return;

        return this.runSerialized(async () => {
            if (!this.sourceRoot || !this.workRoot) return;
            if (!this.keyBytes) throw new Error('Decrypt key missing');
            if (this.version !== 4) {
                // v3 只有一个消息db，做全量同步
                await this.syncDecryptedData(false);
                return;
            }

            // 找到 message 目录下的所有 message_*.db
            const msgSourceDir = join(this.sourceRoot, 'message');
            if (!existsSync(msgSourceDir)) return;

            const entries = readdirSync(msgSourceDir)
                .filter(name => /^message_(\d+)?\.db$/i.test(name));

            let synced = false;
            for (const name of entries) {
                const sourcePath = join(msgSourceDir, name);
                const rel = relative(this.sourceRoot, sourcePath);
                const destPath = join(this.workRoot, rel);

                const versionKey = toUnixMTimeKey(sourcePath);
                const previous = this.fileVersionKey.get(sourcePath);

                if (previous === versionKey && existsSync(destPath)) {
                    continue;
                }

                this.closeDb(destPath);

                try {
                    await this.decryptOrCopyFile(sourcePath, destPath);
                    this.fileVersionKey.set(sourcePath, versionKey);
                    synced = true;
                } catch (e) {
                    this.writeLog(`syncMessageDbForSession failed for ${sourcePath}: ${e}`);
                }
            }

            if (synced) {
                await this.rebuildMessageDbInfos();
            }
        });
    }

    /**
     * 共享的 DLL 重连方法（带冷却 + 互斥锁）
     * 多个调用方（push / HTTP API）共用同一个重连，避免并发冲突
     */
    private async tryDllReconnect(): Promise<boolean> {
        if (!this.dll) return false;

        // 冷却期内不重复重连
        const now = Date.now();
        if (now - this.lastDllReconnectAt < this.dllReconnectCooldownMs) {
            return this.dll.isConnected();
        }

        // 已有重连在进行中，等待其结果
        if (this.dllReconnectPromise) {
            return this.dllReconnectPromise;
        }

        this.lastDllReconnectAt = now;

        this.dllReconnectPromise = (async () => {
            try {
                console.warn('[WcdbCore] 检测到 DLL -3 错误，执行完整重初始化...');

                // 停止 monitor（重连后会重建）
                if (this.dll) {
                    this.dll.stopMonitor();
                }

                const reopened = await this.dll!.reopen();
                if (!reopened) {
                    console.error('[WcdbCore] DLL 重初始化失败');
                    const degraded = await this.degradeToSqlite('DLL 重初始化失败');
                    if (degraded) {
                        console.warn('[WcdbCore] 已自动回退到 SQLite，后台将继续重试 DLL');
                    }
                    return false;
                }

                // 重连后重新启动 monitor
                if (this.monitorCallback && this.dll) {
                    const cb = this.monitorCallback;
                    const monitorOk = this.dll.startMonitor(cb);
                    if (monitorOk) {
                        this.monitorPipeConnected = true;
                        console.log('[WcdbCore] DLL monitor pipe 重连成功');
                    } else {
                        console.warn('[WcdbCore] DLL monitor pipe 重连失败');
                    }
                }

                console.log('[WcdbCore] DLL 重初始化完成');
                return true;
            } catch (e) {
                console.error('[WcdbCore] DLL 重连异常:', e);
                return false;
            } finally {
                this.dllReconnectPromise = null;
            }
        })();

        return this.dllReconnectPromise;
    }

    /**
     * DLL 模式下获取消息，带自动重连
     */
    private async dllGetMessagesForPush(
        sessionId: string,
        limit: number,
        sinceTimestamp: number
    ): Promise<WcdbResult<any[]> | null> {
        if (!this.dll) return null;

        const tryOnce = (): WcdbResult<any[]> | 'reconnect_needed' => {
            const cursorResult = this.dll!.openMessageCursor(sessionId, limit, true, sinceTimestamp, 0);
            if (!cursorResult.success || cursorResult.data === undefined) {
                if (cursorResult.error && cursorResult.error.includes('(-3)')) {
                    return 'reconnect_needed';
                }
                return { success: false, error: cursorResult.error };
            }
            const batchResult = this.dll!.fetchMessageBatch(cursorResult.data);
            this.dll!.closeMessageCursor(cursorResult.data);
            if (!batchResult.success || !batchResult.data) {
                return { success: false, error: batchResult.error };
            }
            return { success: true, data: batchResult.data.rows };
        };

        // 第一次尝试
        const firstResult = tryOnce();
        if (firstResult !== 'reconnect_needed') {
            return firstResult;
        }

        // -3 错误：通过共享重连方法处理
        const reconnected = await this.tryDllReconnect();
        if (!reconnected) {
            const degraded = await this.degradeToSqlite('消息游标 -3 且 DLL 重连失败');
            if (degraded) {
                return null;
            }
            return { success: false, error: 'DLL 重连失败，且回退 SQLite 失败' };
        }

        // 重试
        const retryResult = tryOnce();
        if (retryResult === 'reconnect_needed') {
            console.error('[WcdbCore] DLL 重连后仍返回 -3');
            const degraded = await this.degradeToSqlite('DLL 重连后仍持续返回 -3');
            if (degraded) {
                return null;
            }
            return { success: false, error: 'openMessageCursor 持续失败 (-3)，且回退 SQLite 失败' };
        }
        return retryResult;
    }

    /**
     * 获取增量消息查询结果（供 messagePushService 使用）
     * 直接返回消息行数组，绕过 cursor 机制
     */
    async getMessagesForPush(
        sessionId: string,
        sinceTimestamp: number,
        limit: number = 50
    ): Promise<WcdbResult<any[]>> {
        // DLL 模式：通过游标获取
        if (this.dllMode && this.dll) {
            const result = await this.dllGetMessagesForPush(sessionId, limit, sinceTimestamp);
            if (result) return result;
            // DLL 失败且无法恢复，走 fallback 到下面的 SQLite 逻辑
        }

        return this.runSerialized(async () => {
            if (!this.isConnected()) {
                return { success: false, error: '数据库未连接' };
            }

            try {
                const messages = this.queryMergedMessages(
                    sessionId,
                    sinceTimestamp,  // beginTimestamp
                    0,               // endTimestamp (no upper bound)
                    true,            // ascending
                    limit
                );
                return { success: true, data: messages };
            } catch (e) {
                return { success: false, error: String(e) };
            }
        });
    }

    private async ensureFreshData(force = false): Promise<void> {
        if (!this.connected) return;

        const now = Date.now();
        if (!force && now - this.lastSyncAt < this.minSyncIntervalMs) {
            return;
        }

        await this.syncDecryptedData(false);
    }

    async initialize(): Promise<boolean> {
        if (this.initialized) return true;
        this.initialized = true;
        return true;
    }

    private async openSqliteBackend(
        dbPath: string,
        hexKey: string,
        wxid: string,
        forceFullSync: boolean,
        preserveMonitorCallback: boolean = false
    ): Promise<boolean> {
        if (
            !this.dllMode &&
            this.connected &&
            this.currentPath === dbPath &&
            this.currentKey === hexKey &&
            this.currentWxid === wxid
        ) {
            await this.ensureFreshData(false);
            return true;
        }

        if (preserveMonitorCallback) {
            this.stopMonitorInternal(false);
        } else {
            this.stopMonitor();
        }

        if (this.dll) {
            try {
                this.dll.shutdown();
            } catch { /* ignore */ }
            this.dll = null;
        }

        this.dllMode = false;
        this.dllReconnectPromise = null;
        this.lastDllReconnectAt = 0;
        this.connected = false;

        this.closeAllDbs();
        this.cursors.clear();
        this.fileVersionKey.clear();
        this.messageDbInfos = [];
        this.messageTablesByDb.clear();

        this.keyBytes = toHexKey(hexKey);

        const resolved = this.resolveSourceRoot(dbPath, wxid);
        if (!resolved) {
            this.writeLog(`Cannot locate session DB under path: ${dbPath}`, true);
            this.connected = false;
            return false;
        }

        this.sourceRoot = resolved.sourceRoot;
        this.version = resolved.version;
        this.workRoot = this.resolveWorkRoot(this.sourceRoot, wxid || 'default');

        this.currentPath = dbPath;
        this.currentKey = hexKey;
        this.currentWxid = wxid;

        ensureDirSync(this.workRoot);

        await this.syncDecryptedData(forceFullSync);

        const sessionDb = this.getSessionDbPath();
        if (!existsSync(sessionDb)) {
            this.writeLog(`Session DB not found after decrypt: ${sessionDb}`, true);
            this.connected = false;
            return false;
        }

        // verify key by opening session DB
        this.getDb(sessionDb);

        this.connected = true;
        this.writeLog(`Open success version=${this.version} sourceRoot=${this.sourceRoot}`);
        return true;
    }

    async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
        return this.runSerialized(async () => {
            try {
                await this.initialize();

                const config = getConfig();
                this.dllPreferred = config.dllEnabled && !!config.wcdbResourcesPath;
                this.dllResourcesPath = config.wcdbResourcesPath || '';

                if (!this.dllPreferred) {
                    this.stopDllRetryLoop(true);
                }

                // 已连接且参数未变化：直接复用现有连接
                if (
                    this.connected &&
                    this.currentPath === dbPath &&
                    this.currentKey === hexKey &&
                    this.currentWxid === wxid
                ) {
                    if (!this.dllMode) {
                        await this.ensureFreshData(false);
                    }
                    return true;
                }

                // ======== DLL 模式尝试 ========
                if (this.dllPreferred && this.dllResourcesPath) {
                    const dllOk = await this.tryDllOpen(dbPath, hexKey, wxid, config.wcdbResourcesPath);
                    if (dllOk) {
                        this.stopDllRetryLoop(true);
                        return true;
                    }
                    console.warn('[WcdbCore] DLL 模式初始化失败，回退到 SQLite 模式');
                }

                // ======== SQLite 模式 ========
                const sqliteOk = await this.openSqliteBackend(dbPath, hexKey, wxid, true);
                if (sqliteOk && this.dllPreferred) {
                    this.scheduleDllRetry('启动阶段 DLL 不可用');
                }
                return sqliteOk;
            } catch (e) {
                this.writeLog(`open failed: ${e}`, true);
                this.connected = false;
                return false;
            }
        });
    }

    /**
     * 尝试 DLL 模式初始化
     */
    private async tryDllOpen(dbPath: string, hexKey: string, wxid: string, resourcesPath: string): Promise<boolean> {
        try {
            if (!WcdbDll.isAvailable(resourcesPath)) {
                console.warn('[WcdbCore] DLL 文件不存在:', resourcesPath);
                return false;
            }

            const dll = new WcdbDll();
            const initOk = await dll.initialize(resourcesPath);
            if (!initOk) return false;

            const openOk = await dll.open(dbPath, hexKey, wxid);
            if (!openOk) {
                dll.shutdown();
                return false;
            }

            // DLL 打开成功，切换到 DLL 模式
            const callback = this.monitorCallback;
            this.stopMonitorInternal(false);

            if (this.dll && this.dll !== dll) {
                try {
                    this.dll.shutdown();
                } catch { /* ignore */ }
            }
            this.dll = dll;
            this.dllMode = true;
            this.connected = true;
            this.currentPath = dbPath;
            this.currentKey = hexKey;
            this.currentWxid = wxid;
            this.lastDllReconnectAt = 0;
            this.dllReconnectPromise = null;
            this.dllRetryDelayMs = this.dllRetryInitialDelayMs;
            this.clearDllRetryTimer();

            // 设置 sourceRoot 用于 fs.watch 回退 monitor
            const resolved = this.resolveSourceRoot(dbPath, wxid);
            if (resolved) {
                this.sourceRoot = resolved.sourceRoot;
                this.version = resolved.version;
            }

            if (callback) {
                const monitorOk = this.startMonitor(callback);
                if (!monitorOk) {
                    console.warn('[WcdbCore] DLL 启用后 monitor 重建失败');
                }
            }

            console.log('🚀 DLL 模式已启用 (高性能直读加密数据库)');
            return true;
        } catch (e) {
            console.error('[WcdbCore] DLL 初始化异常:', e);
            return false;
        }
    }

    close(): void {
        void this.runSerialized(() => {
            this.stopDllRetryLoop(true);
            this.stopMonitor();
            if (this.dll) {
                this.dll.shutdown();
                this.dll = null;
            }
            this.dllMode = false;
            this.connected = false;
            this.cursors.clear();
            this.closeAllDbs();
        });
    }

    shutdown(): void {
        void this.runSerialized(() => {
            this.stopDllRetryLoop(true);
            this.stopMonitor();
            if (this.dll) {
                this.dll.shutdown();
                this.dll = null;
                this.dllMode = false;
            }
            this.connected = false;
            this.initialized = false;
            this.cursors.clear();
            this.closeAllDbs();
            this.fileVersionKey.clear();
            this.messageDbInfos = [];
            this.messageTablesByDb.clear();
        });
    }

    isConnected(): boolean {
        return this.initialized && this.connected;
    }

    startMonitor(callback: (type: string, json: string) => void): boolean {
        this.stopMonitor();
        this.monitorCallback = callback;

        if (!this.connected) {
            callback('monitor_unavailable', '{}');
            return false;
        }

        // DLL 模式：使用管道 monitor（表级别精确通知）
        if (this.dllMode && this.dll) {
            const dllOk = this.dll.startMonitor(callback);
            if (dllOk) {
                this.monitorPipeConnected = true;
                console.log('[WcdbCore] DLL monitor pipe 启动成功');
                return true;
            }
            console.warn('[WcdbCore] DLL monitor pipe 启动失败，回退到 fs.watch');
        }

        // SQLite 模式 / 回退：使用 fs.watch
        if (!this.sourceRoot) {
            callback('monitor_unavailable', '{}');
            return false;
        }

        try {
            this.monitorWatcher = watch(this.sourceRoot, { recursive: true }, (_eventType, filename) => {
                if (!filename) return;
                const lower = filename.toLowerCase();
                if (!lower.endsWith('.db')) return;
                if (lower.includes('fts')) return;

                if (this.monitorCallback) {
                    this.monitorCallback('update', JSON.stringify({ action: 'update', file: filename }));
                }
            });

            this.monitorWatcher.on('error', () => {
                this.monitorPipeConnected = false;
                if (this.monitorCallback) {
                    this.monitorCallback('monitor_unavailable', '{}');
                }
            });

            this.monitorPipeConnected = true;
            return true;
        } catch (e) {
            this.monitorPipeConnected = false;
            this.writeLog(`startMonitor failed: ${e}`, true);
            callback('monitor_unavailable', '{}');
            return false;
        }
    }

    isMonitorConnected(): boolean {
        return this.monitorPipeConnected;
    }

    private stopMonitorInternal(clearCallback: boolean): void {
        this.monitorPipeConnected = false;

        // DLL monitor
        if (this.dll) {
            this.dll.stopMonitor();
        }

        if (this.monitorReconnectTimer) {
            clearTimeout(this.monitorReconnectTimer);
            this.monitorReconnectTimer = null;
        }

        if (this.monitorWatcher) {
            try {
                this.monitorWatcher.close();
            } catch {
                // ignore
            }
            this.monitorWatcher = null;
        }

        if (clearCallback) {
            this.monitorCallback = null;
        }
    }

    stopMonitor(): void {
        this.stopMonitorInternal(true);
    }

    async getSessions(): Promise<WcdbResult<any[]>> {
        // DLL 模式：直接调用 DLL（~0.1ms）
        if (this.dllMode && this.dll) {
            return this.dll.getSessions();
        }

        return this.runSerialized(async () => {
            if (!this.isConnected()) {
                return { success: false, error: '数据库未连接' };
            }

            try {
                await this.ensureFreshData(false);

                const sessionDb = this.getDb(this.getSessionDbPath());
                const contactDbPath = this.getContactDbPath();

                let sessions: any[] = [];

                if (this.version === 4) {
                    sessions = sessionDb.prepare(`
                        SELECT
                            username,
                            type,
                            unread_count,
                            last_timestamp,
                            sort_timestamp,
                            last_msg_locald_id,
                            last_msg_type,
                            last_sender_display_name
                        FROM SessionTable
                        ORDER BY sort_timestamp DESC
                    `).all();
                } else {
                    sessions = sessionDb.prepare(`
                        SELECT
                            m_nsUserName AS username,
                            0 AS type,
                            0 AS unread_count,
                            m_uLastTime AS last_timestamp,
                            m_uLastTime AS sort_timestamp,
                            0 AS last_msg_locald_id,
                            0 AS last_msg_type,
                            '' AS last_sender_display_name
                        FROM SessionAbstract
                        ORDER BY m_uLastTime DESC
                    `).all();
                }

                const displayNameMap = new Map<string, string>();
                if (existsSync(contactDbPath)) {
                    const cdb = this.getDb(contactDbPath);
                    if (this.version === 4) {
                        const rows = cdb.prepare('SELECT username, remark, nick_name, alias FROM contact').all() as any[];
                        for (const row of rows) {
                            const display = row.remark || row.nick_name || row.alias || row.username;
                            displayNameMap.set(String(row.username), String(display || row.username));
                        }
                    } else {
                        const rows = cdb.prepare('SELECT m_nsUsrName AS username, m_nsRemark AS remark, nickname AS nick_name, m_nsAliasName AS alias FROM WCContact').all() as any[];
                        for (const row of rows) {
                            const display = row.remark || row.nick_name || row.alias || row.username;
                            displayNameMap.set(String(row.username), String(display || row.username));
                        }
                    }
                }

                const normalized = sessions.map((s) => {
                    const username = String(s.username || '');
                    const displayName = displayNameMap.get(username) || s.last_sender_display_name || username;
                    return {
                        username,
                        display_name: displayName,
                        type: Number(s.type || 0),
                        sort_timestamp: Number(s.sort_timestamp || s.last_timestamp || 0),
                        last_timestamp: Number(s.last_timestamp || 0),
                        unread_count: Number(s.unread_count || 0),
                        last_msg_locald_id: Number(s.last_msg_locald_id || 0),
                        last_msg_type: Number(s.last_msg_type || 0),
                    };
                });

                return { success: true, data: normalized };
            } catch (e) {
                return { success: false, error: String(e) };
            }
        });
    }

    async getDisplayNames(usernames: string[]): Promise<WcdbResult<Record<string, string>>> {
        if (this.dllMode && this.dll) {
            return this.dll.getDisplayNames(usernames);
        }

        return this.runSerialized(async () => {
            if (!this.isConnected()) {
                return { success: false, error: '数据库未连接' };
            }

            try {
                await this.ensureFreshData(false);

                const uniq = Array.from(new Set((usernames || []).filter(Boolean)));
                const result: Record<string, string> = {};

                if (uniq.length === 0) {
                    return { success: true, data: result };
                }

                const contactDbPath = this.getContactDbPath();
                if (existsSync(contactDbPath)) {
                    const db = this.getDb(contactDbPath);
                    const placeholders = uniq.map(() => '?').join(',');

                    if (this.version === 4) {
                        const rows = db.prepare(`
                            SELECT username, remark, nick_name, alias
                            FROM contact
                            WHERE username IN (${placeholders})
                        `).all(...uniq) as any[];

                        for (const row of rows) {
                            const username = String(row.username || '');
                            if (!username) continue;
                            result[username] = String(row.remark || row.nick_name || row.alias || username);
                        }
                    } else {
                        const rows = db.prepare(`
                            SELECT m_nsUsrName AS username, m_nsRemark AS remark, nickname AS nick_name, m_nsAliasName AS alias
                            FROM WCContact
                            WHERE m_nsUsrName IN (${placeholders})
                        `).all(...uniq) as any[];

                        for (const row of rows) {
                            const username = String(row.username || '');
                            if (!username) continue;
                            result[username] = String(row.remark || row.nick_name || row.alias || username);
                        }
                    }
                }

                for (const name of uniq) {
                    if (!result[name]) {
                        result[name] = name;
                    }
                }

                return { success: true, data: result };
            } catch (e) {
                return { success: false, error: String(e) };
            }
        });
    }

    async openMessageCursor(
        sessionId: string,
        batchSize: number,
        ascending: boolean,
        beginTimestamp: number,
        endTimestamp: number
    ): Promise<WcdbResult<number>> {
        if (this.dllMode && this.dll) {
            let result = this.dll.openMessageCursor(sessionId, batchSize, ascending, beginTimestamp, endTimestamp);
            if (!result.success && result.error && result.error.includes('(-3)')) {
                // 通过共享重连方法处理
                const reconnected = await this.tryDllReconnect();
                if (reconnected && this.dllMode && this.dll) {
                    result = this.dll.openMessageCursor(sessionId, batchSize, ascending, beginTimestamp, endTimestamp);
                    if (result.success || !result.error || !result.error.includes('(-3)')) {
                        return result;
                    }
                }

                const degraded = await this.degradeToSqlite('openMessageCursor 持续失败 (-3)');
                if (!degraded) {
                    return { success: false, error: 'openMessageCursor 持续失败 (-3)，且回退 SQLite 失败' };
                }
                // 回退成功后走下面 SQLite 分支
            } else {
                return result;
            }
        }

        return this.runSerialized(async () => {
            if (!this.isConnected()) {
                return { success: false, error: '数据库未连接' };
            }

            try {
                await this.ensureFreshData(false);

                const cursor: MessageCursor = {
                    id: this.nextCursorId++,
                    sessionId,
                    batchSize: Math.max(1, batchSize || 100),
                    ascending,
                    beginTimestamp: Math.max(0, beginTimestamp || 0),
                    endTimestamp: Math.max(0, endTimestamp || 0),
                    offset: 0,
                };

                this.cursors.set(cursor.id, cursor);
                return { success: true, data: cursor.id };
            } catch (e) {
                return { success: false, error: String(e) };
            }
        });
    }

    async fetchMessageBatch(cursor: number): Promise<WcdbResult<{ rows: any[]; hasMore: boolean }>> {
        if (this.dllMode && this.dll) {
            return this.dll.fetchMessageBatch(cursor);
        }

        return this.runSerialized(async () => {
            if (!this.isConnected()) {
                return { success: false, error: '数据库未连接' };
            }

            const state = this.cursors.get(cursor);
            if (!state) {
                return { success: false, error: '消息游标不存在' };
            }

            try {
                await this.ensureFreshData(false);

                const requestTopN = state.offset + state.batchSize + 1;
                const merged = this.queryMergedMessages(
                    state.sessionId,
                    state.beginTimestamp,
                    state.endTimestamp,
                    state.ascending,
                    requestTopN
                );

                const start = state.offset;
                const end = state.offset + state.batchSize;
                const rows = merged.slice(start, end);
                const hasMore = merged.length > end;

                state.offset += rows.length;
                this.cursors.set(cursor, state);

                return { success: true, data: { rows, hasMore } };
            } catch (e) {
                return { success: false, error: String(e) };
            }
        });
    }

    async closeMessageCursor(cursor: number): Promise<WcdbResult<void>> {
        if (this.dllMode && this.dll) {
            return this.dll.closeMessageCursor(cursor);
        }

        return this.runSerialized(async () => {
            this.cursors.delete(cursor);
            return { success: true };
        });
    }

    async getGroupNicknames(chatroomId: string): Promise<WcdbResult<Record<string, string>>> {
        if (this.dllMode && this.dll) {
            return this.dll.getGroupNicknames(chatroomId);
        }

        return this.runSerialized(async () => {
            if (!this.isConnected()) {
                return { success: false, error: '数据库未连接' };
            }

            try {
                await this.ensureFreshData(false);

                const contactDbPath = this.getContactDbPath();
                if (!existsSync(contactDbPath)) {
                    return { success: true, data: {} };
                }

                const db = this.getDb(contactDbPath);

                if (this.version !== 4) {
                    return { success: true, data: {} };
                }

                const row = db
                    .prepare('SELECT ext_buffer FROM chat_room WHERE username = ? LIMIT 1')
                    .get(chatroomId) as { ext_buffer?: Buffer } | undefined;

                if (!row || !row.ext_buffer || !Buffer.isBuffer(row.ext_buffer)) {
                    return { success: true, data: {} };
                }

                const users = parseRoomData(row.ext_buffer);
                const out: Record<string, string> = {};
                for (const user of users) {
                    if (user.userName && user.displayName) {
                        out[user.userName] = user.displayName;
                    }
                }

                return { success: true, data: out };
            } catch (e) {
                return { success: false, error: String(e) };
            }
        });
    }

    async getGroupMembers(chatroomId: string): Promise<WcdbResult<any[]>> {
        if (this.dllMode && this.dll) {
            return this.dll.getGroupMembers(chatroomId);
        }

        return this.runSerialized(async () => {
            if (!this.isConnected()) {
                return { success: false, error: '数据库未连接' };
            }

            try {
                await this.ensureFreshData(false);

                const contactDbPath = this.getContactDbPath();
                if (!existsSync(contactDbPath)) {
                    return { success: true, data: [] };
                }

                const db = this.getDb(contactDbPath);
                const members: any[] = [];

                if (this.version === 4) {
                    const row = db
                        .prepare('SELECT ext_buffer FROM chat_room WHERE username = ? LIMIT 1')
                        .get(chatroomId) as { ext_buffer?: Buffer } | undefined;

                    if (!row || !row.ext_buffer || !Buffer.isBuffer(row.ext_buffer)) {
                        return { success: true, data: [] };
                    }

                    for (const user of parseRoomData(row.ext_buffer)) {
                        members.push({
                            username: user.userName,
                            userName: user.userName,
                            nickname: user.displayName || '',
                            displayName: user.displayName || '',
                        });
                    }

                    return { success: true, data: members };
                }

                return { success: true, data: [] };
            } catch (e) {
                return { success: false, error: String(e) };
            }
        });
    }

    async execQuery(kind: string, path: string | null, sql: string): Promise<WcdbResult<any[]>> {
        if (this.dllMode && this.dll) {
            return this.dll.execQuery(kind, path, sql);
        }

        return this.runSerialized(async () => {
            if (!this.isConnected()) {
                return { success: false, error: '数据库未连接' };
            }

            try {
                await this.ensureFreshData(false);

                let dbPath = '';
                if (path) {
                    dbPath = resolve(path);
                } else {
                    switch ((kind || '').toLowerCase()) {
                        case 'contact':
                        case 'chatroom':
                            dbPath = this.getContactDbPath();
                            break;
                        case 'session':
                            dbPath = this.getSessionDbPath();
                            break;
                        case 'media':
                            dbPath = this.getMediaDbPath();
                            break;
                        case 'message': {
                            const first = this.getCandidateMessageDbs(0, 0)[0];
                            dbPath = first || '';
                            break;
                        }
                        default:
                            dbPath = this.getContactDbPath();
                            break;
                    }
                }

                if (!dbPath || !existsSync(dbPath)) {
                    return { success: true, data: [] };
                }

                const db = this.getDb(dbPath);
                const rows = db.prepare(sql).all() as Array<Record<string, any>>;
                return { success: true, data: rows.map((row) => normalizeSqlRow(row)) };
            } catch (e) {
                return { success: false, error: String(e) };
            }
        });
    }
}

let wcdbInstance: WcdbCore | null = null;

export function getWcdbCore(): WcdbCore {
    if (!wcdbInstance) {
        wcdbInstance = new WcdbCore();
    }
    return wcdbInstance;
}
