const LOG_TAG_COLUMN_WIDTH = 9;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const ansi = {
    reset: '\x1b[0m',
    time: '\x1b[36m',
    separator: '\x1b[37m',
    tag: '\x1b[97m',
    marker: '\x1b[38;5;118m',
};

function pad(number: number, width = 2): string {
    return String(number).padStart(width, '0');
}

function validTimeFrom(dateInput: Date | number = Date.now()): number {
    const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
    const time = date.getTime();
    return Number.isFinite(time) ? time : Date.now();
}

export function formatLogTimestamp(dateInput: Date | number = Date.now()): string {
    const shifted = new Date(validTimeFrom(dateInput) + SHANGHAI_OFFSET_MS);
    return [
        shifted.getUTCFullYear(),
        '-',
        pad(shifted.getUTCMonth() + 1),
        '-',
        pad(shifted.getUTCDate()),
        ' ',
        pad(shifted.getUTCHours()),
        ':',
        pad(shifted.getUTCMinutes()),
        ':',
        pad(shifted.getUTCSeconds()),
    ].join('');
}

export function formatPlainLogLine(tag: string, body: string, dateInput: Date | number = Date.now()): string {
    return `${formatLogTimestamp(dateInput)} | ${tag.padEnd(LOG_TAG_COLUMN_WIDTH)} | ${body}`;
}

function color(text: string, colorCode: string): string {
    return `${colorCode}${text}${ansi.reset}`;
}

function leadingBodyMarker(text = ''): string {
    const value = String(text);
    if (!value || /^\s/.test(value)) return '';

    const pipeIndex = value.indexOf(' | ');
    if (pipeIndex > 0 && pipeIndex <= 60) return value.slice(0, pipeIndex);

    const tokens = value.split(/\s+/).filter(Boolean);
    if (!tokens.length) return '';
    if (tokens[0].includes('=')) return tokens[0];

    const markerTokens = [tokens[0]];
    for (let i = 1; i < tokens.length && markerTokens.length < 4; i += 1) {
        if (tokens[i].includes('=')) break;
        markerTokens.push(tokens[i]);
    }

    return markerTokens.join(' ');
}

function colorBody(body: string): string {
    const arrowIndex = body.indexOf(' → ');
    if (arrowIndex > 0) {
        return `${color(body.slice(0, arrowIndex), ansi.marker)}${color(body.slice(arrowIndex), ansi.tag)}`;
    }

    const marker = leadingBodyMarker(body);
    if (!marker) return body;
    return `${color(marker, ansi.marker)}${body.slice(marker.length)}`;
}

export function formatConsoleLogLine(tag: string, body: string, dateInput: Date | number = Date.now()): string {
    const separator = color('|', ansi.separator);
    return [
        color(formatLogTimestamp(dateInput), ansi.time),
        separator,
        color(tag.padEnd(LOG_TAG_COLUMN_WIDTH), ansi.tag),
        separator,
        colorBody(body),
    ].join(' ');
}

export function logWithTag(
    tag: string,
    body: string,
    level: 'log' | 'warn' | 'error' = 'log',
    ...args: unknown[]
): void {
    console[level](formatConsoleLogLine(tag, body), ...args);
}
