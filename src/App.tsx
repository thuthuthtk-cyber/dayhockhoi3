import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { Sidebar, resolveUserDisplayName } from './components/Sidebar';
import { PortalView } from './components/PortalView';
import { StudentAssistantChat } from './components/StudentAssistantChat';
import { ErrorBoundary } from './components/ErrorBoundary';

import { Lesson5EModule } from './components/modules/Lesson5EModule';
import { AssignmentModule } from './components/modules/AssignmentModule';
import { QuestionBankModule } from './components/modules/QuestionBankModule';
import { InteractiveGamesModule } from './components/modules/InteractiveGamesModule';
import { UserManagementModule } from './components/modules/UserManagementModule';
import { StudentAssignmentModule } from './components/modules/StudentAssignmentModule';
import { StudentLessonModule } from './components/modules/StudentLessonModule';
import { StudentELearning } from './components/modules/StudentELearning';
import { UseQuestionBankModal } from './components/modules/UseQuestionBankModal';
import { GameRoomConfigModal } from './components/modules/GameRoomConfigModal';

import { ModuleType, UserRole, Lesson5EPlan, HomeworkAssignment, QuestionItem, GameItem, UserAccount, StudentRecord } from './types';
import { INITIAL_USERS } from './services/mockData';
import { db, auth } from './services/firebase';
import { collection, doc, setDoc, deleteDoc, onSnapshot } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { resolveTeacherNameByEmail, verifyTeacherAuthorization } from './services/teacherStorageService';
import { getStudentsFromLocalStorage } from './services/studentStorageService';
import {
  parseSsoParamsFromUrl,
  extractSsoPayloadFromMessage,
  authenticateSsoPayload,
  stripSensitiveSsoParamsFromUrl,
  sanitizeTeacherModule,
  clearAllAuthSessions
} from './services/ssoService';
import {
  saveQuestionToFirestore,
  saveQuestionsBatchToFirestore,
  deleteQuestionFromFirestore,
  deleteQuestionsBatchFromFirestore,
  subscribeToQuestionsFromFirestore,
  getLocalCachedQuestions
} from './services/questionStorageService';
import {
  saveAssignmentToFirestore,
  deleteAssignmentFromFirestore,
  subscribeToAssignmentsFromFirestore,
  getLocalCachedAssignments
} from './services/assignmentStorageService';
import {
  saveGameToFirestore,
  deleteGameFromFirestore,
  subscribeToGamesFromFirestore,
  getLocalCachedGames
} from './services/gameStorageService';
import { initializeAndSyncAllCollections } from './services/dbInitService';
import {
  saveLessonToFirestore,
  deleteLessonFromFirestore,
  subscribeToLessonsFromFirestore,
  getLocalCachedLessons
} from './services/lessonStorageService';
import { CheckCircle2, AlertCircle, Info, Sparkles, X } from 'lucide-react';
import { RewardToastNotification } from './components/common/RewardToastNotification';

const DEFAULT_TEACHER_EMAIL = 'thuthuthtk@gmail.com';

function checkHasSavedSession(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const isActive = localStorage.getItem('eduplay_active_session') === 'true';
    if (!isActive) return false;
    const savedRole = localStorage.getItem('eduplay_active_role');
    if (savedRole === 'student') {
      return Boolean(localStorage.getItem('eduplay_student_session'));
    }
    return Boolean(localStorage.getItem('eduplay_teacher_email'));
  } catch {
    return false;
  }
}

export function App() {
  const initialSsoHint = React.useMemo(() => parseSsoParamsFromUrl(), []);

  const [showPortal, setShowPortal] = useState<boolean>(() => {
    if (initialSsoHint) return false;
    return !checkHasSavedSession();
  });
  const [isSsoAuthenticating, setIsSsoAuthenticating] = useState<boolean>(() => Boolean(initialSsoHint));

  const [activeModule, setActiveModule] = useState<ModuleType>(() => {
    if (initialSsoHint) {
      return sanitizeTeacherModule(initialSsoHint.module);
    }
    if (typeof window !== 'undefined') {
      const savedRole = localStorage.getItem('eduplay_active_role');
      if (savedRole === 'student') return 'assignment';
    }
    return 'lesson_5e';
  });
  const [userRole, setUserRole] = useState<UserRole>(() => {
    if (initialSsoHint) {
      return initialSsoHint.role === 'admin' ? 'admin' : 'teacher';
    }
    if (typeof window === 'undefined') return 'teacher';
    try {
      const savedRole = localStorage.getItem('eduplay_active_role');
      if (savedRole === 'student' || savedRole === 'teacher' || savedRole === 'admin') {
        return savedRole;
      }
    } catch {
      return 'teacher';
    }
    return 'teacher';
  });
  const [gameInitialTab, setGameInitialTab] = useState<'games' | 'store'>('games');

  // Teacher Session State (populated cleanly from SSO or explicit Portal login)
  const [teacherEmail, setTeacherEmail] = useState<string>(() => {
    if (initialSsoHint?.email) return initialSsoHint.email;
    if (typeof window !== 'undefined') {
      try {
        const savedEmail = localStorage.getItem('eduplay_teacher_email');
        if (savedEmail && savedEmail.trim()) return savedEmail;
      } catch {}
    }
    return DEFAULT_TEACHER_EMAIL;
  });
  const [teacherName, setTeacherName] = useState<string>(() => {
    if (initialSsoHint?.email) {
      return resolveTeacherNameByEmail(initialSsoHint.email, initialSsoHint.name || null, undefined, 'teacher');
    }
    if (typeof window !== 'undefined') {
      try {
        const email = localStorage.getItem('eduplay_teacher_email') || DEFAULT_TEACHER_EMAIL;
        const saved = localStorage.getItem('eduplay_teacher_name');
        return resolveTeacherNameByEmail(email, saved, undefined, 'admin');
      } catch {}
    }
    return 'Nguyễn Thị Thu';
  });

  // Grade 3 Class & Student Session State
  const [currentGrade, setCurrentGrade] = useState<string>('Khối 3');
  const [currentClass, setCurrentClass] = useState<string>(() => {
    if (typeof window === 'undefined') return 'Lớp 3C';
    try {
      return localStorage.getItem('eduplay_current_class') || 'Lớp 3C';
    } catch {
      return 'Lớp 3C';
    }
  });
  const [currentStudent, setCurrentStudent] = useState<StudentRecord | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const saved = localStorage.getItem('eduplay_student_session');
      if (saved) return JSON.parse(saved);
      const cls = localStorage.getItem('eduplay_current_class') || 'Lớp 3C';
      const roster = getStudentsFromLocalStorage(cls);
      if (roster && roster.length > 0) {
        return roster[0];
      }
    } catch {
      return null;
    }
    return null;
  });

  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('eduplay_gemini_api_key') || '');
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState(false);

  // Application Data States
  const [lessons5E, setLessons5E] = useState<Lesson5EPlan[]>(() => getLocalCachedLessons());
  const [assignments, setAssignments] = useState<HomeworkAssignment[]>(() => getLocalCachedAssignments());
  const [questionBank, setQuestionBank] = useState<QuestionItem[]>(() => getLocalCachedQuestions());
  const [games, setGames] = useState<GameItem[]>(() => getLocalCachedGames());
  const [userAccounts, setUserAccounts] = useState<UserAccount[]>(INITIAL_USERS);
  const [isUseQuestionBankModalOpen, setIsUseQuestionBankModalOpen] = useState(false);
  const [gameRoomConfigData, setGameRoomConfigData] = useState<{
    isOpen: boolean;
    id?: string;
    title: string;
    subject: string;
    grade: string;
    classInfo?: string;
    maxPlayers?: number;
    status?: 'open' | 'closed';
    timePerQuestion?: string;
    isTimeLimited?: boolean;
    questions: QuestionItem[];
  } | null>(null);
  const [toastNotification, setToastNotification] = useState<{
    id: number;
    title: string;
    message: string;
    type: 'success' | 'info' | 'error';
  } | null>(null);

  // Initialize and Sync all Firebase collections on mount
  useEffect(() => {
    initializeAndSyncAllCollections().then(res => {
      if (res.success) {
        console.log('Firebase collections sync status:', res.message);
      }
    }).catch(err => {
      console.warn('Firebase collections init warning:', err);
    });
  }, []);

  // Sync QuestionBank with Firestore Real-time listener
  useEffect(() => {
    const unsubscribe = subscribeToQuestionsFromFirestore(
      (loadedQuestions) => {
        if (loadedQuestions && loadedQuestions.length > 0) {
          setQuestionBank(loadedQuestions);
        }
      },
      (err) => {
        console.warn('Firestore live subscription fallback active:', err);
      }
    );

    return () => unsubscribe();
  }, []);

  // Sync HomeworkAssignments with Firestore Real-time listener
  useEffect(() => {
    const unsubscribe = subscribeToAssignmentsFromFirestore(
      (loadedAssignments) => {
        if (loadedAssignments && loadedAssignments.length > 0) {
          setAssignments(loadedAssignments);
        }
      },
      (err) => {
        console.warn('Firestore live assignments subscription fallback active:', err);
      }
    );

    return () => unsubscribe();
  }, []);

  // Sync Games with Firestore Real-time listener
  useEffect(() => {
    const unsubscribe = subscribeToGamesFromFirestore(
      (loadedGames) => {
        if (loadedGames && loadedGames.length > 0) {
          setGames(loadedGames);
        }
      },
      (err) => {
        console.warn('Firestore live games subscription fallback active:', err);
      }
    );

    return () => unsubscribe();
  }, []);

  // Sync Lessons with Firestore Real-time listener
  useEffect(() => {
    const unsubscribe = subscribeToLessonsFromFirestore(
      (loadedLessons) => {
        if (loadedLessons && loadedLessons.length > 0) {
          setLessons5E(loadedLessons);
        }
      },
      (err) => {
        console.warn('Firestore live lessons subscription fallback active:', err);
      }
    );

    return () => unsubscribe();
  }, []);

  // Global Toast Notification Listener
  useEffect(() => {
    const handleToastEvent = (e: any) => {
      if (e.detail) {
        setToastNotification({
          id: Date.now(),
          title: e.detail.title || 'Thông báo hệ thống',
          message: e.detail.message || '',
          type: e.detail.type || 'success'
        });
        const timer = setTimeout(() => {
          setToastNotification(null);
        }, 4000);
        return () => clearTimeout(timer);
      }
    };

    window.addEventListener('eduplay_toast', handleToastEvent);
    return () => {
      window.removeEventListener('eduplay_toast', handleToastEvent);
    };
  }, []);

  // RBAC Access Guard: Prevent unauthorized module access
  useEffect(() => {
    if (userRole === 'student') {
      if (activeModule === 'question_bank' || activeModule === 'user_management') {
        setActiveModule('assignment');
      }
    }
  }, [userRole, activeModule]);

  // SSO Auto-Login Handler (URL parameters + iframe window.postMessage)
  useEffect(() => {
    let isMounted = true;

    const applySsoPayload = async (
      payload: ReturnType<typeof parseSsoParamsFromUrl>,
      replyTarget?: { win: Window | null; origin?: string }
    ) => {
      if (!payload) return;
      try {
        if (isMounted) setIsSsoAuthenticating(true);
        const result = await authenticateSsoPayload(payload);
        stripSensitiveSsoParamsFromUrl();

        if (!isMounted) return;

        if (result.authorized) {
          setTeacherEmail(result.email);
          setTeacherName(result.name);
          setUserRole(result.role);
          setActiveModule(result.targetModule);
          setShowPortal(false);

          setToastNotification({
            id: Date.now(),
            title: 'Đăng nhập SSO thành công',
            message: `Xin chào ${result.name} — đã mở Quản lý Bài tập Khối 3.`,
            type: 'success'
          });
          setTimeout(() => {
            if (isMounted) setToastNotification(null);
          }, 4000);

          if (replyTarget?.win) {
            try {
              replyTarget.win.postMessage(
                {
                  type: 'EDUPLAY_SSO_AUTHENTICATED',
                  success: true,
                  email: result.email,
                  role: result.role,
                  module: result.targetModule
                },
                replyTarget.origin && replyTarget.origin !== 'null' ? replyTarget.origin : '*'
              );
            } catch {}
          }
        } else {
          await clearAllAuthSessions();
          if (isMounted) {
            setShowPortal(true);
            setToastNotification({
              id: Date.now(),
              title: 'Không thể tự động đăng nhập',
              message: result.reason || 'Tài khoản chưa được cấp quyền truy cập Khối 3.',
              type: 'error'
            });
          }

          if (replyTarget?.win) {
            try {
              replyTarget.win.postMessage(
                {
                  type: 'EDUPLAY_SSO_AUTHENTICATED',
                  success: false,
                  reason: result.reason
                },
                replyTarget.origin && replyTarget.origin !== 'null' ? replyTarget.origin : '*'
              );
            } catch {}
          }
        }
      } catch (err: any) {
        console.warn('SSO execution error:', err);
        stripSensitiveSsoParamsFromUrl();
        if (isMounted) {
          setShowPortal(true);
          setToastNotification({
            id: Date.now(),
            title: 'Lỗi xác thực SSO',
            message: err?.message || 'Vui lòng đăng nhập thủ công qua Cổng Giáo Viên.',
            type: 'error'
          });
        }
      } finally {
        if (isMounted) setIsSsoAuthenticating(false);
      }
    };

    // 1. Check URL query / hash parameters on startup
    if (initialSsoHint) {
      const parentWin = typeof window !== 'undefined' && window.self !== window.top ? window.parent : null;
      applySsoPayload(initialSsoHint, parentWin ? { win: parentWin, origin: '*' } : undefined);
    }

    // 2. Listen for iframe postMessage credentials from Parent App
    const handlePostMessage = (event: MessageEvent) => {
      try {
        const ssoPayload = extractSsoPayloadFromMessage(event.data, event.origin);
        if (!ssoPayload) return;
        const sourceWin = (event.source as Window | null) || (window.self !== window.top ? window.parent : null);
        applySsoPayload(ssoPayload, sourceWin ? { win: sourceWin, origin: event.origin } : undefined);
      } catch (err) {
        console.warn('postMessage SSO handler warning:', err);
      }
    };

    window.addEventListener('message', handlePostMessage);

    // 3. Notify Parent App that Khối 3 iframe is ready to receive SSO credentials
    try {
      if (window.self !== window.top && window.parent) {
        window.parent.postMessage({ type: 'EDUPLAY_SSO_READY', app: 'khoi3' }, '*');
      }
    } catch {}

    return () => {
      isMounted = false;
      window.removeEventListener('message', handlePostMessage);
    };
  }, [initialSsoHint]);

  // Sync Firebase Auth state when an active Firebase session exists (does not override SSO or student login)
  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      try {
        if (user && user.email) {
          const isSsoActive = localStorage.getItem('eduplay_sso_active') === 'true';
          const isStudentMode = localStorage.getItem('eduplay_active_role') === 'student';
          if (isSsoActive || isStudentMode) return;

          const check = await verifyTeacherAuthorization(user.email);
          if (check.authorized && check.profile) {
            const resolvedName =
              check.profile.name || resolveTeacherNameByEmail(user.email, user.displayName, undefined, check.profile.userRole);
            setTeacherEmail(user.email.toLowerCase());
            setTeacherName(resolvedName);
            localStorage.setItem('eduplay_teacher_email', user.email.toLowerCase());
            localStorage.setItem('eduplay_teacher_name', resolvedName);
            if (localStorage.getItem('eduplay_active_session') === 'true') {
              setUserRole(check.profile.userRole);
              setShowPortal(false);
            }
          }
        }
      } catch (err) {
        console.warn('Auth state sync notice:', err);
      }
    });
    return () => unsubscribe();
  }, []);

  // Sync live teacher updates across the application
  useEffect(() => {
    const handleTeachersUpdated = (e: any) => {
      const teachers = e.detail?.teachers;
      const resolved = resolveTeacherNameByEmail(teacherEmail, null, teachers);
      if (resolved && resolved !== teacherName) {
        setTeacherName(resolved);
        localStorage.setItem('eduplay_teacher_name', resolved);
      }
    };

    window.addEventListener('eduplay_teachers_updated', handleTeachersUpdated);
    return () => {
      window.removeEventListener('eduplay_teachers_updated', handleTeachersUpdated);
    };
  }, [teacherEmail, teacherName]);

  // Save Handlers with Live Activity Logs & Stat Updates
  const handleSaveApiKey = (key: string) => {
    setApiKey(key);
    localStorage.setItem('eduplay_gemini_api_key', key);
  };

  const handleSaveLesson5E = async (lesson: Lesson5EPlan) => {
    setLessons5E((prev) => {
      const exists = prev.find((item) => item.id === lesson.id);
      if (exists) {
        return prev.map((item) => (item.id === lesson.id ? lesson : item));
      }
      return [lesson, ...prev];
    });

    try {
      await saveLessonToFirestore(lesson);
    } catch (err) {
      console.warn('Lỗi khi lưu bài giảng lên Firestore:', err);
    }
  };

  const handleDeleteLesson5E = async (id: string) => {
    setLessons5E((prev) => prev.filter((item) => item.id !== id));

    try {
      await deleteLessonFromFirestore(id);
    } catch (err) {
      console.warn('Lỗi khi xóa bài giảng khỏi Firestore:', err);
    }
  };

  const handleSaveAssignment = async (assignment: HomeworkAssignment) => {
    setAssignments((prev) => {
      const exists = prev.find((item) => item.id === assignment.id);
      if (exists) {
        return prev.map((item) => (item.id === assignment.id ? assignment : item));
      }
      return [assignment, ...prev];
    });

    try {
      await saveAssignmentToFirestore(assignment);
    } catch (err) {
      console.warn('Lỗi khi lưu bài tập lên Firestore:', err);
    }
  };

  const handleDeleteAssignment = async (id: string) => {
    setAssignments((prev) => prev.filter((item) => item.id !== id));

    try {
      await deleteAssignmentFromFirestore(id);
    } catch (err) {
      console.warn('Lỗi khi xóa bài tập khỏi Firestore:', err);
    }
  };

  const handleSaveGame = async (game: GameItem) => {
    setGames((prev) => {
      const exists = prev.find((item) => item.id === game.id);
      if (exists) {
        return prev.map((item) => (item.id === game.id ? game : item));
      }
      return [game, ...prev];
    });

    try {
      await saveGameToFirestore(game);
    } catch (err) {
      console.warn('Lỗi khi lưu trò chơi lên Firestore:', err);
    }
  };

  const handleDeleteGame = async (id: string) => {
    setGames((prev) => prev.filter((item) => item.id !== id));

    try {
      await deleteGameFromFirestore(id);
    } catch (err) {
      console.warn('Lỗi khi xóa trò chơi khỏi Firestore:', err);
    }
  };

  const handleSaveQuestion = async (question: QuestionItem) => {
    try {
      await saveQuestionToFirestore(question);
    } catch (e) {
      console.error('Error saving question to Firestore:', e);
      throw e;
    }
  };

  const handleSaveQuestions = async (questionsToSave: QuestionItem[]) => {
    try {
      await saveQuestionsBatchToFirestore(questionsToSave);
    } catch (e) {
      console.error('Error saving batch questions to Firestore:', e);
      throw e;
    }
  };

  const handleDeleteQuestion = async (_id: string) => {};

  const handleBatchDeleteQuestions = async (_ids: string[]) => {};

  const handleSaveUser = (user: UserAccount) => {
    setUserAccounts((prev) => {
      const exists = prev.find((item) => item.id === user.id);
      if (exists) {
        return prev.map((item) => (item.id === user.id ? user : item));
      }
      return [user, ...prev];
    });
  };

  const handleDeleteUser = (id: string) => {
    setUserAccounts((prev) => prev.filter((item) => item.id !== id));
  };

  const handleSelectPortal = (
    role: UserRole,
    grade?: string,
    selectedClass?: string,
    userDetails?: { email?: string; name?: string; student?: StudentRecord }
  ) => {
    try {
      localStorage.setItem('eduplay_active_session', 'true');
      localStorage.setItem('eduplay_active_role', role);
      localStorage.removeItem('eduplay_sso_active');

      setUserRole(role);
      setCurrentGrade(grade || 'Khối 3');
      if (selectedClass) {
        setCurrentClass(selectedClass);
        localStorage.setItem('eduplay_current_class', selectedClass);
        localStorage.setItem('eduplay_active_class', selectedClass);
      }

      if (role === 'student') {
        if (userDetails?.student) {
          setCurrentStudent(userDetails.student);
          localStorage.setItem('eduplay_student_session', JSON.stringify(userDetails.student));
          window.dispatchEvent(
            new CustomEvent('eduplay_student_session_updated', { detail: { student: userDetails.student } })
          );
        }
        setActiveModule('assignment');
      } else {
        const email = (userDetails?.email || teacherEmail || DEFAULT_TEACHER_EMAIL).trim().toLowerCase();
        const name = resolveTeacherNameByEmail(email, userDetails?.name || null, undefined, role);
        setTeacherEmail(email);
        setTeacherName(name);
        localStorage.setItem('eduplay_teacher_email', email);
        localStorage.setItem('eduplay_teacher_name', name);
        setActiveModule('lesson_5e');
      }

      setShowPortal(false);
    } catch (err) {
      console.warn('Lỗi khi chọn cổng đăng nhập:', err);
      setShowPortal(false);
    }
  };

  const handleLogout = async () => {
    await clearAllAuthSessions();
    setShowPortal(true);
    setActiveModule('lesson_5e');
  };

  const handleSwitchPortalMode = (targetRole: UserRole, targetClass?: string) => {
    const effectiveClass = targetClass || currentClass || 'Lớp 3C';
    setUserRole(targetRole);
    setCurrentGrade('Khối 3');
    setCurrentClass(effectiveClass);
    try {
      localStorage.setItem('eduplay_active_session', 'true');
      localStorage.setItem('eduplay_active_role', targetRole);
    } catch {}

    if (targetRole === 'student') {
      const roster = getStudentsFromLocalStorage(effectiveClass);
      const existingMatchesClass =
        currentStudent &&
        (currentStudent.className || '').replace(/^Lớp\s*/i, '').trim().toUpperCase() ===
          effectiveClass.replace(/^Lớp\s*/i, '').trim().toUpperCase();

      const stObj: StudentRecord =
        (existingMatchesClass && !targetClass ? currentStudent : roster?.[0]) || {
          id: `st-${effectiveClass.replace(/^Lớp\s*/i, '').toLowerCase()}-1`,
          stt: 1,
          code: `${effectiveClass.replace(/^Lớp\s*/i, '').toUpperCase()}26-27-1`,
          sddcn: '038316001001',
          name: `Học sinh ${effectiveClass}`,
          fullName: `Học sinh ${effectiveClass}`,
          gender: 'Nam',
          dob: '15/05/2017',
          className: effectiveClass,
          parentName: 'Phụ huynh',
          phone: '0985608063',
          email: `hs.${effectiveClass.replace(/^Lớp\s*/i, '').toLowerCase()}1@quanghungpk1.edu.vn`,
          status: 'active',
          conduct: 'Tốt',
          avgScore: 9.0,
          avatar: '🐰',
          coins: 1000
        };
      setCurrentStudent(stObj);
      localStorage.setItem('eduplay_student_session', JSON.stringify(stObj));
      localStorage.setItem('eduplay_current_class', effectiveClass);
      localStorage.setItem('eduplay_active_class', effectiveClass);
      window.dispatchEvent(new CustomEvent('eduplay_student_session_updated', { detail: { student: stObj } }));
    } else {
      const email = localStorage.getItem('eduplay_teacher_email') || DEFAULT_TEACHER_EMAIL;
      const name = resolveTeacherNameByEmail(email, null, undefined, 'admin');
      setTeacherEmail(email);
      setTeacherName(name);
      localStorage.setItem('eduplay_teacher_email', email);
      localStorage.setItem('eduplay_teacher_name', name);
    }

    setActiveModule('lesson_5e');
  };

  if (isSsoAuthenticating) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-6 font-sans">
        <div className="bg-white rounded-3xl shadow-xl border border-slate-200/80 p-8 max-w-sm w-full text-center space-y-4">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-indigo-50 border border-indigo-200 flex items-center justify-center">
            <div className="w-7 h-7 border-3 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-extrabold text-slate-900">Đang đồng bộ đăng nhập...</h2>
            <p className="text-xs text-slate-500">
              Hệ thống đang xác thực tài khoản giáo viên và mở Quản lý Bài tập Khối 3.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (showPortal) {
    return <PortalView onSelectPortal={handleSelectPortal} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col font-sans antialiased selection:bg-indigo-500 selection:text-white">
      
      {/* Sticky Top Header & Navigation Shell */}
      <div className="sticky top-0 z-40 w-full">
        {/* Header Bar */}
        <Header
          userRole={userRole}
          currentUserName={userRole === 'student' ? (currentStudent?.name || 'Hoàng Bảo An') : teacherName}
          apiKey={apiKey}
          onSaveApiKey={handleSaveApiKey}
          isApiKeyModalOpen={isApiKeyModalOpen}
          setIsApiKeyModalOpen={setIsApiKeyModalOpen}
        />

        {/* Unified Horizontal Topbar Navigation (Teacher & Student) */}
        <Sidebar
          activeModule={activeModule}
          onSelectModule={setActiveModule}
          userRole={userRole}
          badgeCounts={{
            lessonsCount: lessons5E.length,
            assignmentsCount: assignments.length,
            questionsCount: questionBank.length
          }}
          teacherName={teacherName}
          teacherEmail={teacherEmail}
          currentStudent={currentStudent}
          currentClass={currentClass}
          userName={userRole === 'student' ? (currentStudent?.name || 'Học sinh Khối 3') : teacherName}
          userEmail={teacherEmail}
          onLogout={handleLogout}
          onSwitchRole={(role, targetClass) => handleSwitchPortalMode(role, targetClass)}
        />
      </div>

      {/* Main Body */}
      <div className="flex-1 flex flex-col max-w-[1400px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
        {/* Dynamic Module Content View */}
        <main className="flex-1 min-w-0 h-full">
          <ErrorBoundary fallbackTitle="Không thể tải phân hệ học tập này">
            {(() => {
              const safeModule = (userRole === 'student' && (activeModule === 'question_bank' || activeModule === 'user_management'))
                ? 'assignment'
                : activeModule;

              if (safeModule === 'lesson_5e') {
                return userRole === 'student' ? (
                  <StudentELearning
                    lessons={lessons5E}
                    currentUserId={currentStudent?.code || 'u-4'}
                    currentUserName={currentStudent?.name || 'Lê Minh Anh'}
                    currentClass={currentClass}
                  />
                ) : (
                  <Lesson5EModule
                    lessons={lessons5E}
                    onSaveLesson={handleSaveLesson5E}
                    onDeleteLesson={handleDeleteLesson5E}
                    userRole={userRole}
                  />
                );
              }

              if (safeModule === 'assignment') {
                return userRole === 'student' ? (
                  <StudentAssignmentModule
                    assignments={assignments}
                    onSaveAssignment={handleSaveAssignment}
                    currentUserId={currentStudent?.code || 'u-4'}
                    currentUserName={currentStudent?.name || 'Lê Minh Anh'}
                  />
                ) : (
                  <AssignmentModule
                    assignments={assignments}
                    onSaveAssignment={handleSaveAssignment}
                    onDeleteAssignment={handleDeleteAssignment}
                    userRole={userRole}
                  />
                );
              }

              if (safeModule === 'interactive_games') {
                return (
                  <InteractiveGamesModule
                    games={games}
                    userRole={userRole}
                    currentUserId={currentStudent?.id || 'u-4'}
                    currentUserName={currentStudent?.name || 'Lê Minh Anh'}
                    initialTab={gameInitialTab}
                    onOpenUseQuestionBankModal={() => setIsUseQuestionBankModalOpen(true)}
                    onOpenEditGameRoom={(game) => {
                      setGameRoomConfigData({
                        isOpen: true,
                        id: game.id,
                        title: game.title,
                        subject: game.subject,
                        grade: game.grade,
                        classInfo: game.classInfo,
                        maxPlayers: game.maxPlayers || 10,
                        status: game.status || 'open',
                        timePerQuestion: game.timePerQuestion || '10 giây / câu (Nhanh tay lẹ mắt)',
                        isTimeLimited: game.isTimeLimited ?? true,
                        questions: game.questions.map((q: any) => ({
                          id: q.id,
                          code: 'Q00',
                          subject: game.subject,
                          grade: game.grade,
                          level: 'nhan_biet' as any,
                          type: q.type || 'trac_nghiem',
                          question: q.question || q.content,
                          content: q.content || q.question,
                          options: q.options || [],
                          answer: q.answer || q.correctAnswer,
                          correctAnswer: q.correctAnswer || q.answer,
                          explanation: q.explanation || '',
                          statements: q.statements || [],
                          matchingPairs: q.matchingPairs || [],
                          classificationItems: q.classificationItems || [],
                          classificationGroups: q.classificationGroups || []
                        }))
                      });
                    }}
                    onDeleteGame={(id) => {
                      handleDeleteGame(id);
                      setToastNotification({
                        id: Date.now(),
                        title: 'Đã xóa',
                        message: 'Đã xóa phòng thi đấu thành công khỏi CSDL',
                        type: 'success'
                      });
                    }}
                    onUpdateGame={(updatedGame) => {
                      handleSaveGame(updatedGame);
                      setToastNotification({
                        id: Date.now(),
                        title: 'Cập nhật',
                        message: 'Đã cập nhật trạng thái phòng thi đấu lên CSDL',
                        type: 'success'
                      });
                    }}
                  />
                );
              }

              if (safeModule === 'question_bank' && userRole !== 'student') {
                return (
                  <QuestionBankModule
                    questions={questionBank}
                    onSaveQuestion={handleSaveQuestion}
                    onSaveQuestions={handleSaveQuestions}
                    onDeleteQuestion={handleDeleteQuestion}
                    onBatchDeleteQuestions={handleBatchDeleteQuestions}
                    userRole={userRole}
                    onAssignHomework={(config) => {
                      const newAssignment: HomeworkAssignment = {
                        id: `hw-bank-${Date.now()}`,
                        title: config.title,
                        subject: config.subject,
                        grade: config.grade,
                        targetClass: config.classes.join(', '),
                        dueDate: config.dueDate,
                        description: `Bài tập tự luyện môn ${config.subject} gồm ${config.selectedQuestions.length} câu hỏi chuẩn sư phạm.`,
                        questions: config.selectedQuestions,
                        totalStudents: 35 * (config.classes.length || 1),
                        completedCount: 0,
                        submissions: [],
                        createdAt: new Date().toISOString()
                      };
                      handleSaveAssignment(newAssignment);
                    }}
                    onCreateGame={(gameData) => {
                      const newGame: GameItem = {
                        id: `game-${Date.now()}`,
                        title: gameData.title || `Trò chơi tương tác môn ${gameData.subject || 'Công nghệ'}`,
                        type: 'speed_quiz',
                        subject: gameData.subject || 'Công nghệ',
                        grade: gameData.grade || 'Khối 3',
                        description: `Trò chơi học tập trực tuyến tạo từ Ngân hàng câu hỏi (${gameData.questions?.length || 0} câu).`,
                        questions: (gameData.questions || []).map((q: any) => ({
                          id: q.id,
                          type: q.type,
                          question: q.question || q.content,
                          content: q.content || q.question,
                          options: q.options || [],
                          answer: q.answer || q.correctAnswer,
                          correctAnswer: q.correctAnswer || q.answer,
                          explanation: q.explanation || '',
                          statements: q.statements || [],
                          matchingPairs: q.matchingPairs || [],
                          classificationItems: q.classificationItems || [],
                          classificationGroups: q.classificationGroups || []
                        })),
                        playersCount: 0,
                        status: 'open'
                      };
                      handleSaveGame(newGame);
                      setActiveModule('interactive_games');
                      setToastNotification({
                        id: Date.now(),
                        title: 'Thành công',
                        message: `Đã tạo trò chơi "${newGame.title}" và lưu vào cơ sở dữ liệu!`,
                        type: 'success'
                      });
                    }}
                    onNavigate={(mod) => setActiveModule(mod as any)}
                  />
                );
              }

              if (safeModule === 'user_management' && userRole !== 'student') {
                return (
                  <UserManagementModule
                    users={userAccounts}
                    onSaveUser={handleSaveUser}
                    onDeleteUser={handleDeleteUser}
                    userRole={userRole}
                  />
                );
              }

              return null;
            })()}
          </ErrorBoundary>
        </main>
      </div>

      {/* Floating AI Assistant (Only for Student) */}
      {userRole === 'student' && <StudentAssistantChat />}

      {/* Reward Popup Toast with Quick Store Navigation */}
      <RewardToastNotification
        onNavigateToStore={() => {
          setGameInitialTab('store');
          setActiveModule('interactive_games');
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('eduplay_open_game_store'));
          }, 50);
        }}
      />

      {/* Global Toast Notification */}
      {toastNotification && (
        <div className="fixed bottom-6 right-6 z-50 animate-bounce-in max-w-sm w-full">
          <div className="bg-slate-900/95 backdrop-blur-md text-white p-4 rounded-2xl shadow-2xl border border-slate-700/80 flex items-start gap-3">
            <div className="p-2 rounded-xl bg-teal-500/20 text-teal-300 shrink-0">
              {toastNotification.type === 'success' ? (
                <CheckCircle2 className="w-5 h-5 text-teal-400" />
              ) : toastNotification.type === 'error' ? (
                <AlertCircle className="w-5 h-5 text-rose-400" />
              ) : (
                <Info className="w-5 h-5 text-sky-400" />
              )}
            </div>
            <div className="flex-1 min-w-0 pt-0.5">
              <h4 className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                {toastNotification.title}
              </h4>
              <p className="text-xs text-slate-300 font-medium mt-0.5 leading-relaxed">
                {toastNotification.message}
              </p>
            </div>
            <button
              onClick={() => setToastNotification(null)}
              className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Use Question Bank Modal for Interactive Games */}
      <UseQuestionBankModal
        isOpen={isUseQuestionBankModalOpen}
        onClose={() => setIsUseQuestionBankModalOpen(false)}
        questions={questionBank}
        onOpenGameRoomConfig={(config) => {
          setGameRoomConfigData({ isOpen: true, ...config });
        }}
        onCreateGame={(gameData) => {
          const newGame: GameItem = {
            id: `game-${Date.now()}`,
            title: gameData.title,
            type: 'speed_quiz',
            subject: gameData.subject,
            grade: gameData.grade,
            description: `Trò chơi tương tác tạo từ Ngân hàng câu hỏi (${gameData.questions.length} câu).`,
            questions: gameData.questions.map((q: any) => ({
              id: q.id,
              type: q.type,
              question: q.question || q.content,
              content: q.content || q.question,
              options: q.options || [],
              answer: q.answer || q.correctAnswer,
              correctAnswer: q.correctAnswer || q.answer,
              explanation: q.explanation || '',
              statements: q.statements || [],
              matchingPairs: q.matchingPairs || [],
              classificationItems: q.classificationItems || [],
              classificationGroups: q.classificationGroups || []
            })),
            playersCount: 0
          };
          handleSaveGame(newGame);
          setIsUseQuestionBankModalOpen(false);
          setToastNotification({
            id: Date.now(),
            title: 'Thành công',
            message: `Đã tạo trò chơi Quizzi thành công từ ${gameData.questions.length} câu hỏi ngân hàng và lưu CSDL!`,
            type: 'success'
          });
        }}
      />

      {/* Game Room Configuration Modal */}
      <GameRoomConfigModal
        isOpen={Boolean(gameRoomConfigData?.isOpen)}
        onClose={() => setGameRoomConfigData(null)}
        initialData={gameRoomConfigData}
        onSaveGameRoom={(savedGame) => {
          const isExisting = games.some(g => g.id === savedGame.id);
          handleSaveGame(savedGame);
          if (isExisting) {
            setToastNotification({
              id: Date.now(),
              title: 'Thành công',
              message: `Đã cập nhật phòng trò chơi "${savedGame.title}" thành công lên CSDL!`,
              type: 'success'
            });
          } else {
            setToastNotification({
              id: Date.now(),
              title: 'Thành công',
              message: `Đã tạo phòng trò chơi trực quan thành công với ${savedGame.questions.length} câu hỏi và lưu CSDL!`,
              type: 'success'
            });
          }
          setActiveModule('interactive_games');
        }}
      />

    </div>
  );
}

export default App;
