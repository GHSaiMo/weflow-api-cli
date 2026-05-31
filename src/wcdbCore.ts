/**
 * WeFlow API CLI - WCDB Core platform selector
 *
 * Keeps the public wcdbCore import stable while routing database access to the
 * implementation for the current operating system.
 */
import { getWcdbCore as getMacWcdbCore, WcdbCore as MacWcdbCore } from './platform/mac/wcdbCore.js';
import { getWcdbCore as getWinWcdbCore, WcdbCore as WinWcdbCore } from './platform/win/wcdbCore.js';

export type PlatformWcdbCore = MacWcdbCore | WinWcdbCore;

export function getWcdbCore(): PlatformWcdbCore {
    if (process.platform === 'darwin') {
        return getMacWcdbCore();
    }

    if (process.platform === 'win32') {
        return getWinWcdbCore();
    }

    throw new Error(`Unsupported platform: ${process.platform}. WeFlow API CLI currently supports Windows and macOS.`);
}
