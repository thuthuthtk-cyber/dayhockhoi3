import { signInWithCustomToken, signOut } from 'firebase/auth';
import { auth } from './firebase';
import {
  verifyTeacherAuthorization,
  resolveTeacherNameByEmail,
  TeacherProfileResult
} from './teacherStorageService';
import { ActiveModule, UserRole } from '../types';

export const DEFAULT_SSO_FALLBACK_EMAIL = 'thuthuthtk@gmail.com';
export const SSO_SESSION_KEY = 'eduplay_sso_session';
export const SSO_USER_KEY = 'eduplay_sso_current_user';
export const SSO_TOKEN_KEY = 'eduplay_sso_token';
export const ACTIVE_MODULE_KEY = 'eduplay_active_module';

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
  messageType?: string;
}

export interface StoredSsoSession {
  email: string;
  name: string;
  role: UserRole;
  teacherId?: string;
  targetModule?: ActiveModule;
  token?: string;
  authenticatedAt: number;
  viaIframe?: boolean;
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
  'sso_email',
  'email',
  'userEmail',
  'teacher_email',
  'sso_token',
  'token',
  'idToken',
  'accessToken',
  'authToken',
  'customToken',
  'firebaseCustomToken',
  'sso_custom_token',
  'auto_login',
  'autologin',
  'autoLogin',
  'sso',
  'sso_name',
  'name',
  'displayName',
  'sso_role',
  'role',
  'source',
  'parentOrigin'
];

/**
 * Safely detect whether app is running inside a parent iframe (e.g. "Dạy và Học Số PK Trực Khang").
 */
export function isEmbeddedInIframe(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return window.self !== window.top;
  } catch {
    // Accessing window.top cross-origin throws SecurityError when embedded in an iframe
    return true;
  }
}

/**
 * Sanitize requested module for Teacher SSO.
 * Defaults to 'assignment' (Quản Lý Bài Tập) when launched from parent portal.
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
    if (!cleanToken) {
      return { valid: true, derivedEmail: providedEmail };
    }

    const jwtPayload = decodeJwtPayloadSafe(cleanToken);
    if (jwtPayload) {
      // Check JWT expiration if present (with 5 min clock skew tolerance for embedded SSO)
      if (typeof jwtPayload.exp === 'number' && jwtPayload.exp * 1000 < Date.now() - 300_000) {
        return {
          valid: false,
          reason: 'Phiên đăng nhập từ cổng chính đã hết hạn. Vui lòng đăng nhập lại.'
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
 * Recognizes ?sso_email=, ?sso_token=, ?auto_login=true as well as ?email=, ?token=, ?autologin=true, ?sso=true.
 */
export function parseSsoParamsFromUrl(): SsoPayload | null {
  try {
    if (typeof window === 'undefined') return null;

    const searchParams = new URLSearchParams(window.location.search || '');
    const merged = new URLSearchParams();

    searchParams.forEach((value, key) => {
      merged.set(key, value);
    });

    // Also support query params placed inside URL hash (e.g. #/?sso_email=...&auto_login=true)
    const rawHash = window.location.hash || '';
    const hashQueryIndex = rawHash.indexOf('?');
    if (hashQueryIndex !== -1) {
      const hashQuery = rawHash.slice(hashQueryIndex + 1);
      const hashParams = new URLSearchParams(hashQuery);
      hashParams.forEach((value, key) => {
        if (!merged.has(key)) merged.set(key, value);
      });
    }

    const email = (
      merged.get('sso_email') ||
      merged.get('email') ||
      merged.get('userEmail') ||
      merged.get('teacher_email') ||
      ''
    )
      .trim()
      .toLowerCase() || undefined;

    const token = (
      merged.get('sso_token') ||
      merged.get('token') ||
      merged.get('idToken') ||
      merged.get('accessToken') ||
      merged.get('authToken') ||
      ''
    ).trim() || undefined;

    const customToken = (
      merged.get('customToken') ||
      merged.get('firebaseCustomToken') ||
      merged.get('sso_custom_token') ||
      ''
    ).trim() || undefined;

    const autoFlag =
      isTruthyFlag(merged.get('auto_login')) ||
      isTruthyFlag(merged.get('autologin')) ||
      isTruthyFlag(merged.get('autoLogin')) ||
      isTruthyFlag(merged.get('sso'));

    const hasExplicitSsoParams =
      merged.has('sso_email') ||
      merged.has('sso_token') ||
      isTruthyFlag(merged.get('auto_login')) ||
      autoFlag ||
      Boolean(email && (token || customToken));

    if (!hasExplicitSsoParams) return null;

    return {
      email,
      token,
      customToken,
      autologin: true,
      module: (merged.get('module') || merged.get('tab') || merged.get('target') || '').trim() || undefined,
      role: (merged.get('sso_role') || merged.get('role') || '').trim() || undefined,
      name: (merged.get('sso_name') || merged.get('name') || merged.get('displayName') || '').trim() || undefined,
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
 * Prioritizes type === 'PK_TRUC_KHANG_SSO_LOGIN' as well as standard SSO message types.
 */
export function extractSsoPayloadFromMessage(data: any, origin?: string): SsoPayload | null {
  try {
    if (!data || typeof data !== 'object') return null;

    const msgType = typeof data.type === 'string' ? data.type.trim().toUpperCase() : '';
    const isKnownMessageType =
      msgType === 'PK_TRUC_KHANG_SSO_LOGIN' ||
      msgType === 'EDUPLAY_SSO_LOGIN' ||
      msgType === 'SSO_LOGIN' ||
      msgType === 'AUTH_SSO' ||
      msgType === 'PARENT_AUTH_SYNC' ||
      msgType === 'EDUPLAY_AUTH_PAYLOAD';

    // Support flat data, data.payload, data.user, data.currentUser, or data.teacher
    const nestedSource =
      (data.payload && typeof data.payload === 'object' && data.payload) ||
      (data.user && typeof data.user === 'object' && data.user) ||
      (data.currentUser && typeof data.currentUser === 'object' && data.currentUser) ||
      (data.teacher && typeof data.teacher === 'object' && data.teacher) ||
      data;

    const email = (
      nestedSource.sso_email ||
      nestedSource.email ||
      nestedSource.userEmail ||
      data.sso_email ||
      data.email ||
      ''
    )
      .toString()
      .trim()
      .toLowerCase() || undefined;

    const token = (
      nestedSource.sso_token ||
      nestedSource.token ||
      nestedSource.idToken ||
      nestedSource.accessToken ||
      nestedSource.authToken ||
      data.sso_token ||
      data.token ||
      ''
    )
      .toString()
      .trim() || undefined;

    const customToken = (
      nestedSource.customToken ||
      nestedSource.firebaseCustomToken ||
      nestedSource.sso_custom_token ||
      data.customToken ||
      ''
    )
      .toString()
      .trim() || undefined;

    const autologin =
      isKnownMessageType ||
      isTruthyFlag(nestedSource.auto_login) ||
      isTruthyFlag(nestedSource.autologin) ||
      isTruthyFlag(nestedSource.autoLogin) ||
      isTruthyFlag(nestedSource.sso) ||
      isTruthyFlag(data.auto_login) ||
      isTruthyFlag(data.autologin);

    if (!autologin) {
      return null;
    }

    if (!email && !token && !customToken && msgType !== 'PK_TRUC_KHANG_SSO_LOGIN') {
      return null;
    }

    const rawName =
      nestedSource.sso_name ||
      nestedSource.name ||
      nestedSource.displayName ||
      data.sso_name ||
      data.name ||
      data.displayName;

    const rawRole = nestedSource.sso_role || nestedSource.role || data.sso_role || data.role;
    const rawModule =
      nestedSource.module || nestedSource.target || data.module || data.target;

    return {
      email,
      token,
      customToken,
      autologin: true,
      module: typeof rawModule === 'string' ? rawModule : undefined,
      role: typeof rawRole === 'string' ? rawRole : undefined,
      name: typeof rawName === 'string' ? rawName : undefined,
      className: typeof nestedSource.className === 'string' ? nestedSource.className : undefined,
      sourceOrigin: origin,
      messageType: msgType || undefined
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
 * Read persisted SSO session from localStorage safely.
 */
export function getStoredSsoSession(): StoredSsoSession | null {
  try {
    if (typeof window === 'undefined') return null;
    const isSsoActive = localStorage.getItem('eduplay_sso_active') === 'true';
    const rawSession = localStorage.getItem(SSO_SESSION_KEY) || localStorage.getItem(SSO_USER_KEY);
    if (rawSession) {
      const parsed = JSON.parse(rawSession);
      if (parsed && typeof parsed === 'object' && parsed.email) {
        return parsed as StoredSsoSession;
      }
    }
    if (isSsoActive) {
      const email = localStorage.getItem('eduplay_teacher_email');
      if (email) {
        const savedRole = localStorage.getItem('eduplay_active_role');
        const savedName = localStorage.getItem('eduplay_teacher_name') || 'Giáo viên';
        const savedModule = localStorage.getItem(ACTIVE_MODULE_KEY);
        return {
          email: email.trim().toLowerCase(),
          name: savedName,
          role: savedRole === 'admin' ? 'admin' : 'teacher',
          teacherId: localStorage.getItem('eduplay_teacher_id') || undefined,
          targetModule: sanitizeTeacherModule(savedModule),
          authenticatedAt: Date.now()
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Persist verified SSO / embedded currentUser session to localStorage so page reloads & tab switches stay logged in.
 */
export function persistSsoSessionToLocalStorage(session: StoredSsoSession): void {
  try {
    if (typeof window === 'undefined') return;
    localStorage.setItem('eduplay_active_session', 'true');
    localStorage.setItem('eduplay_sso_active', 'true');
    localStorage.setItem('eduplay_active_role', session.role);
    localStorage.setItem('eduplay_teacher_email', session.email);
    localStorage.setItem('eduplay_teacher_name', session.name);
    if (session.teacherId) {
      localStorage.setItem('eduplay_teacher_id', session.teacherId);
    }
    if (session.token) {
      localStorage.setItem(SSO_TOKEN_KEY, session.token);
      sessionStorage.setItem(SSO_TOKEN_KEY, session.token);
    }
    if (session.targetModule) {
      localStorage.setItem(ACTIVE_MODULE_KEY, session.targetModule);
    }

    const serialized = JSON.stringify(session);
    localStorage.setItem(SSO_SESSION_KEY, serialized);
    localStorage.setItem(SSO_USER_KEY, serialized);
    sessionStorage.setItem(SSO_SESSION_KEY, serialized);

    window.dispatchEvent(
      new CustomEvent('eduplay_teacher_session_updated', {
        detail: {
          email: session.email,
          name: session.name,
          role: session.role,
          sso: true
        }
      })
    );
  } catch (storageErr) {
    console.warn('Không thể lưu phiên SSO vào localStorage:', storageErr);
  }
}

/**
 * Validate and authenticate a teacher SSO payload from the parent portal ("Dạy và Học Số PK Trực Khang").
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
      }
    }

    // 3. Fallback to stored or default teacher session if auto_login / iframe handshake didn't pass email explicitly
    if (!isValidEmailFormat(resolvedEmail)) {
      const existingStored = getStoredSsoSession();
      const storedTeacherEmail =
        typeof window !== 'undefined' ? localStorage.getItem('eduplay_teacher_email') : null;
      const candidate = (existingStored?.email || storedTeacherEmail || DEFAULT_SSO_FALLBACK_EMAIL)
        .trim()
        .toLowerCase();
      if (isValidEmailFormat(candidate)) {
        resolvedEmail = candidate;
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

    // 4. Lookup teacher authorization & profile in Firestore / whitelist / local database
    const authCheck = await verifyTeacherAuthorization(resolvedEmail);

    // Reject only if explicitly locked/inactive
    if (!authCheck.authorized && authCheck.reason && authCheck.reason.toLowerCase().includes('tạm khóa')) {
      return {
        authorized: false,
        email: resolvedEmail,
        name: '',
        role: 'teacher',
        targetModule: sanitizeTeacherModule(payload.module),
        reason: authCheck.reason
      };
    }

    const requestedAdmin =
      payload.role?.toLowerCase().includes('admin') ||
      payload.role?.toLowerCase().includes('quản trị');

    const profile: TeacherProfileResult = authCheck.profile || {
      id: `sso-${resolvedEmail.split('@')[0]}`,
      name:
        payload.name?.trim() ||
        resolveTeacherNameByEmail(resolvedEmail, payload.name || null, undefined, requestedAdmin ? 'admin' : 'teacher'),
      email: resolvedEmail,
      role: requestedAdmin ? 'Quản trị viên (ADMIN)' : 'Giáo viên bộ môn',
      userRole: requestedAdmin ? 'admin' : 'teacher',
      avatar: '👩‍🏫'
    };

    const resolvedName =
      profile.name ||
      resolveTeacherNameByEmail(resolvedEmail, payload.name || null, undefined, profile.userRole);

    const resolvedRole: UserRole =
      profile.userRole === 'admin' || requestedAdmin ? 'admin' : 'teacher';

    const targetModule = sanitizeTeacherModule(payload.module);

    // 5. Persist SSO session cleanly to localStorage (survives reload & tab navigation)
    persistSsoSessionToLocalStorage({
      email: resolvedEmail,
      name: resolvedName,
      role: resolvedRole,
      teacherId: profile.id,
      targetModule,
      token: payload.token,
      authenticatedAt: Date.now(),
      viaIframe: isEmbeddedInIframe()
    });

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
      localStorage.removeItem(SSO_SESSION_KEY);
      localStorage.removeItem(SSO_USER_KEY);
      localStorage.removeItem(SSO_TOKEN_KEY);
      localStorage.removeItem(ACTIVE_MODULE_KEY);
      sessionStorage.removeItem(SSO_TOKEN_KEY);
      sessionStorage.removeItem(SSO_SESSION_KEY);
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
