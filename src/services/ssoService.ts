import { signInWithCustomToken, signOut } from 'firebase/auth';
import { auth } from './firebase';
import {
  verifyTeacherAuthorization,
  resolveTeacherNameByEmail,
  TeacherProfileResult
} from './teacherStorageService';
import { ActiveModule, UserRole } from '../types';

export interface SsoPayload {
  email?: string;
  token?: string;
  customToken?: string;
  autologin: boolean;
  module?: string;
  role?: string;
  name?: string;
  className?: string;
  sourceOrigin?: string;
}

export interface SsoAuthResult {
  authorized: boolean;
  email: string;
  name: string;
  role: UserRole;
  targetModule: ActiveModule;
  profile?: TeacherProfileResult;
  reason?: string;
}

const VALID_TEACHER_MODULES: ActiveModule[] = [
  'lesson_5e',
  'question_bank',
  'assignment',
  'interactive_games',
  'user_management'
];

const SSO_URL_PARAM_KEYS = [
  'email',
  'userEmail',
  'token',
  'idToken',
  'accessToken',
  'ssoToken',
  'authToken',
  'customToken',
  'firebaseCustomToken',
  'autologin',
  'autoLogin',
  'sso',
  'name',
  'displayName',
  'role',
  'source',
  'parentOrigin'
];

/**
 * Sanitize requested module for Teacher SSO.
 * Defaults to 'assignment' (Quản Lý Bài Tập) as requested when launching Khối 3 from the parent app.
 */
export function sanitizeTeacherModule(rawModule?: string | null): ActiveModule {
  try {
    if (!rawModule || typeof rawModule !== 'string') return 'assignment';
    const normalized = rawModule.trim().toLowerCase();
    if (normalized === 'assignments' || normalized === 'baitap' || normalized === 'bai_tap') {
      return 'assignment';
    }
    if (normalized === 'lessons' || normalized === 'lesson' || normalized === 'baigiang') {
      return 'lesson_5e';
    }
    if (normalized === 'questions' || normalized === 'nganhang') {
      return 'question_bank';
    }
    if (normalized === 'games' || normalized === 'trochoi') {
      return 'interactive_games';
    }
    if (normalized === 'users' || normalized === 'nguoidung') {
      return 'user_management';
    }
    if ((VALID_TEACHER_MODULES as string[]).includes(normalized)) {
      return normalized as ActiveModule;
    }
  } catch {
    // fallback
  }
  return 'assignment';
}

function isTruthyFlag(val?: string | boolean | number | null): boolean {
  if (val === true || val === 1) return true;
  if (typeof val !== 'string') return false;
  const clean = val.trim().toLowerCase();
  return clean === 'true' || clean === '1' || clean === 'yes';
}

function isValidEmailFormat(email?: string | null): email is string {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

/**
 * Safely decode JWT payload without throwing on non-JWT opaque tokens.
 */
export function decodeJwtPayloadSafe(token?: string | null): Record<string, any> | null {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const base64Url = parts[1];
    if (!base64Url) return null;

    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const jsonPayload = decodeURIComponent(
      atob(padded)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    const parsed = JSON.parse(jsonPayload);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate optional token (if JWT, verify expiry & email consistency).
 */
function validateSsoTokenConsistency(
  token: string | undefined,
  providedEmail: string | undefined
): { valid: boolean; derivedEmail?: string; reason?: string } {
  try {
    if (!token) {
      return { valid: true, derivedEmail: providedEmail };
    }
    const cleanToken = token.trim();
    if (!cleanToken || cleanToken.length < 8) {
      return { valid: false, reason: 'Token xác thực SSO không hợp lệ.' };
    }

    const jwtPayload = decodeJwtPayloadSafe(cleanToken);
    if (jwtPayload) {
      // Check JWT expiration if present (with 60s clock skew tolerance)
      if (typeof jwtPayload.exp === 'number' && jwtPayload.exp * 1000 < Date.now() - 60_000) {
        return {
          valid: false,
          reason: 'Phiên đăng nhập từ hệ thống chính đã hết hạn. Vui lòng đăng nhập lại.'
        };
      }

      const tokenEmail =
        typeof jwtPayload.email === 'string' ? jwtPayload.email.trim().toLowerCase() : undefined;

      if (tokenEmail && providedEmail && tokenEmail !== providedEmail.trim().toLowerCase()) {
        return {
          valid: false,
          reason: 'Thông tin email và token xác thực SSO không khớp.'
        };
      }

      return {
        valid: true,
        derivedEmail: providedEmail || tokenEmail
      };
    }

    // Opaque session token (non-JWT)
    return { valid: true, derivedEmail: providedEmail };
  } catch {
    return { valid: false, reason: 'Không thể kiểm tra token SSO.' };
  }
}

/**
 * Parse SSO parameters from both window.location.search and window.location.hash safely.
 */
export function parseSsoParamsFromUrl(): SsoPayload | null {
  try {
    if (typeof window === 'undefined') return null;

    const searchParams = new URLSearchParams(window.location.search || '');
    const merged = new URLSearchParams();

    searchParams.forEach((value, key) => {
      merged.set(key, value);
    });

    // Also support query params placed inside URL hash (e.g. #/?email=...&autologin=true)
    const rawHash = window.location.hash || '';
    const hashQueryIndex = rawHash.indexOf('?');
    if (hashQueryIndex !== -1) {
      const hashQuery = rawHash.slice(hashQueryIndex + 1);
      const hashParams = new URLSearchParams(hashQuery);
      hashParams.forEach((value, key) => {
        if (!merged.has(key)) merged.set(key, value);
      });
    }

    const email = (merged.get('email') || merged.get('userEmail') || '').trim().toLowerCase() || undefined;
    const token = (
      merged.get('token') ||
      merged.get('idToken') ||
      merged.get('accessToken') ||
      merged.get('ssoToken') ||
      merged.get('authToken') ||
      ''
    ).trim() || undefined;
    const customToken = (
      merged.get('customToken') ||
      merged.get('firebaseCustomToken') ||
      ''
    ).trim() || undefined;

    const autoFlag =
      isTruthyFlag(merged.get('autologin')) ||
      isTruthyFlag(merged.get('autoLogin')) ||
      isTruthyFlag(merged.get('sso'));

    const hasCredentials = Boolean(email || token || customToken);
    // Trigger SSO if autologin/sso flag is explicitly true with credentials, OR if email + token are passed together
    const shouldTrigger = hasCredentials && (autoFlag || (Boolean(email) && Boolean(token || customToken)));

    if (!shouldTrigger) return null;

    return {
      email,
      token,
      customToken,
      autologin: true,
      module: (merged.get('module') || merged.get('tab') || merged.get('target') || '').trim() || undefined,
      role: (merged.get('role') || '').trim() || undefined,
      name: (merged.get('name') || merged.get('displayName') || '').trim() || undefined,
      className: (merged.get('class') || merged.get('className') || '').trim() || undefined,
      sourceOrigin: (merged.get('parentOrigin') || merged.get('source') || '').trim() || undefined
    };
  } catch (err) {
    console.warn('parseSsoParamsFromUrl warning:', err);
    return null;
  }
}

/**
 * Extract SSO payload from incoming iframe window.postMessage event data.
 */
export function extractSsoPayloadFromMessage(data: any, origin?: string): SsoPayload | null {
  try {
    if (!data || typeof data !== 'object') return null;

    const msgType = typeof data.type === 'string' ? data.type.trim().toUpperCase() : '';
    const isKnownMessageType =
      msgType === 'EDUPLAY_SSO_LOGIN' ||
      msgType === 'SSO_LOGIN' ||
      msgType === 'AUTH_SSO' ||
      msgType === 'PARENT_AUTH_SYNC' ||
      msgType === 'EDUPLAY_AUTH_PAYLOAD';

    const source = data.payload && typeof data.payload === 'object' ? data.payload : data;

    const email = (source.email || source.userEmail || '').toString().trim().toLowerCase() || undefined;
    const token = (
      source.token ||
      source.idToken ||
      source.accessToken ||
      source.ssoToken ||
      source.authToken ||
      ''
    )
      .toString()
      .trim() || undefined;
    const customToken = (source.customToken || source.firebaseCustomToken || '').toString().trim() || undefined;

    const autologin = isTruthyFlag(source.autologin) || isTruthyFlag(source.autoLogin) || isTruthyFlag(source.sso);

    if (!isKnownMessageType && !autologin) {
      return null;
    }

    if (!email && !token && !customToken) {
      return null;
    }

    return {
      email,
      token,
      customToken,
      autologin: true,
      module: typeof source.module === 'string' ? source.module : typeof source.target === 'string' ? source.target : undefined,
      role: typeof source.role === 'string' ? source.role : undefined,
      name: typeof source.name === 'string' ? source.name : typeof source.displayName === 'string' ? source.displayName : undefined,
      className: typeof source.className === 'string' ? source.className : undefined,
      sourceOrigin: origin
    };
  } catch {
    return null;
  }
}

/**
 * Remove sensitive SSO tokens/parameters from the browser address bar without reloading.
 */
export function stripSensitiveSsoParamsFromUrl(): void {
  try {
    if (typeof window === 'undefined' || !window.history?.replaceState) return;
    const url = new URL(window.location.href);
    let modified = false;

    for (const key of SSO_URL_PARAM_KEYS) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        modified = true;
      }
    }

    // Also clean module param once navigated so browser refresh preserves chosen module or cleans URL neatly
    if (url.searchParams.has('module')) {
      url.searchParams.delete('module');
      modified = true;
    }
    if (url.searchParams.has('tab')) {
      url.searchParams.delete('tab');
      modified = true;
    }
    if (url.searchParams.has('target')) {
      url.searchParams.delete('target');
      modified = true;
    }

    if (modified) {
      const nextUrl = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState({}, document.title, nextUrl || '/');
    }
  } catch (err) {
    console.warn('Không thể làm sạch tham số SSO khỏi URL:', err);
  }
}

/**
 * Validate and authenticate a teacher SSO payload against Firebase Auth / Teacher Authorization registry.
 */
export async function authenticateSsoPayload(payload: SsoPayload): Promise<SsoAuthResult> {
  try {
    // 1. Validate optional JWT/opaque token
    const tokenCheck = validateSsoTokenConsistency(payload.token, payload.email);
    if (!tokenCheck.valid) {
      return {
        authorized: false,
        email: payload.email || '',
        name: '',
        role: 'teacher',
        targetModule: sanitizeTeacherModule(payload.module),
        reason: tokenCheck.reason || 'Token xác thực SSO không hợp lệ.'
      };
    }

    let resolvedEmail = (tokenCheck.derivedEmail || payload.email || '').trim().toLowerCase();

    // 2. If parent sent a Firebase Custom Token, sign in to Firebase Auth directly
    if (payload.customToken && auth) {
      try {
        const cred = await signInWithCustomToken(auth, payload.customToken);
        if (!resolvedEmail && cred.user?.email) {
          resolvedEmail = cred.user.email.trim().toLowerCase();
        }
      } catch (firebaseErr: any) {
        console.warn('SSO signInWithCustomToken notice:', firebaseErr?.message || firebaseErr);
        // Continue if we have an authorized email; fail only if email itself is missing
      }
    }

    if (!isValidEmailFormat(resolvedEmail)) {
      return {
        authorized: false,
        email: resolvedEmail,
        name: '',
        role: 'teacher',
        targetModule: sanitizeTeacherModule(payload.module),
        reason: 'Thiếu địa chỉ email hợp lệ để đăng nhập tự động.'
      };
    }

    // 3. Verify teacher authorization against Firestore / whitelist / local database
    const authCheck = await verifyTeacherAuthorization(resolvedEmail);
    if (!authCheck.authorized || !authCheck.profile) {
      return {
        authorized: false,
        email: resolvedEmail,
        name: '',
        role: 'teacher',
        targetModule: sanitizeTeacherModule(payload.module),
        reason:
          authCheck.reason ||
          `Tài khoản ${resolvedEmail} chưa được cấp quyền truy cập phân hệ Khối 3.`
      };
    }

    const profile = authCheck.profile;
    const resolvedName =
      profile.name ||
      resolveTeacherNameByEmail(resolvedEmail, payload.name || null, undefined, profile.userRole);

    const resolvedRole: UserRole =
      profile.userRole === 'admin' || payload.role === 'admin' ? 'admin' : 'teacher';

    const targetModule = sanitizeTeacherModule(payload.module);

    // 4. Persist session markers safely
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem('eduplay_active_session', 'true');
        localStorage.setItem('eduplay_sso_active', 'true');
        localStorage.setItem('eduplay_active_role', resolvedRole);
        localStorage.setItem('eduplay_teacher_email', resolvedEmail);
        localStorage.setItem('eduplay_teacher_name', resolvedName);
        localStorage.setItem('eduplay_teacher_id', profile.id);

        if (payload.token) {
          sessionStorage.setItem('eduplay_sso_token', payload.token);
        }
        sessionStorage.setItem(
          'eduplay_sso_session',
          JSON.stringify({
            email: resolvedEmail,
            name: resolvedName,
            role: resolvedRole,
            targetModule,
            authenticatedAt: Date.now()
          })
        );

        window.dispatchEvent(
          new CustomEvent('eduplay_teacher_session_updated', {
            detail: { email: resolvedEmail, name: resolvedName, role: resolvedRole, sso: true }
          })
        );
      }
    } catch (storageErr) {
      console.warn('Không thể lưu phiên SSO vào bộ nhớ trình duyệt:', storageErr);
    }

    return {
      authorized: true,
      email: resolvedEmail,
      name: resolvedName,
      role: resolvedRole,
      targetModule,
      profile
    };
  } catch (err: any) {
    console.error('SSO authentication error:', err);
    return {
      authorized: false,
      email: payload.email || '',
      name: '',
      role: 'teacher',
      targetModule: sanitizeTeacherModule(payload.module),
      reason: err?.message || 'Đã xảy ra lỗi khi xác thực đăng nhập tự động (SSO).'
    };
  }
}

/**
 * Clear active local & session auth markers on explicit logout.
 */
export async function clearAllAuthSessions(): Promise<void> {
  try {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('eduplay_active_session');
      localStorage.removeItem('eduplay_sso_active');
      localStorage.removeItem('eduplay_active_role');
      localStorage.removeItem('eduplay_teacher_email');
      localStorage.removeItem('eduplay_teacher_name');
      localStorage.removeItem('eduplay_teacher_id');
      localStorage.removeItem('eduplay_student_session');
      sessionStorage.removeItem('eduplay_sso_token');
      sessionStorage.removeItem('eduplay_sso_session');
    }
  } catch (err) {
    console.warn('Lỗi khi xóa phiên đăng nhập local:', err);
  }

  try {
    if (auth && auth.currentUser) {
      await signOut(auth);
    }
  } catch (err) {
    console.warn('Lỗi khi đăng xuất Firebase Auth:', err);
  }
}
