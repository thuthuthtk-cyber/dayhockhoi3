import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { Sidebar, resolveUserDisplayName } from './components/Sidebar';
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
import { resolveTeacherNameByEmail } from './services/teacherStorageService';
import { getStudentsFromLocalStorage } from './services/studentStorageService';
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

export function App() {
  const [activeModule, setActiveModule] = useState<ModuleType>('lesson_5e');
  const [userRole, setUserRole] = useState<UserRole>(() => {
    if (typeof window === 'undefined') return 'admin';
    const savedRole = localStorage.getItem('eduplay_active_role');
    if (savedRole === 'student' || savedRole === 'teacher' || savedRole === 'admin') {
      return savedRole;
    }
    return 'admin';
  });
  const [gameInitialTab, setGameInitialTab] = useState<'games' | 'store'>('games');

  // Silent Auto-Login Teacher Session State
  const [teacherEmail, setTeacherEmail] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const savedEmail = localStorage.getItem('eduplay_teacher_email');
      if (savedEmail && savedEmail.trim()) return savedEmail;
      localStorage.setItem('eduplay_teacher_email', DEFAULT_TEACHER_EMAIL);
    }
    return DEFAULT_TEACHER_EMAIL;
  });
  const [teacherName, setTeacherName] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const email = localStorage.getItem('eduplay_teacher_email') || DEFAULT_TEACHER_EMAIL;
      const saved = localStorage.getItem('eduplay_teacher_name');
      const resolved = resolveTeacherNameByEmail(email, saved, undefined, 'admin');
      localStorage.setItem('eduplay_teacher_name', resolved);
      return resolved;
    }
    return 'Nguyễn Thị Thu';
  });

  // Silent Grade 3 Class & Student Session State
  const [currentGrade, setCurrentGrade] = useState<string>('Khối 3');
  const [currentClass, setCurrentClass] = useState<string>(() => {
    if (typeof window === 'undefined') return 'Lớp 3C';
    return localStorage.getItem('eduplay_current_class') || 'Lớp 3C';
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

  // Sync Firebase Auth state with Teacher session if signed in, while keeping silent default session active
  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user && user.email) {
        setTeacherEmail(user.email);
        localStorage.setItem('eduplay_teacher_email', user.email);
        const resolvedName = resolveTeacherNameByEmail(user.email, user.displayName, undefined, 'admin');
        setTeacherName(resolvedName);
        localStorage.setItem('eduplay_teacher_name', resolvedName);
      } else {
        const storedEmail = localStorage.getItem('eduplay_teacher_email') || DEFAULT_TEACHER_EMAIL;
        const resolvedName = resolveTeacherNameByEmail(storedEmail, null, undefined, 'admin');
        setTeacherEmail(storedEmail);
        setTeacherName(resolvedName);
        localStorage.setItem('eduplay_teacher_email', storedEmail);
        localStorage.setItem('eduplay_teacher_name', resolvedName);
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

  const handleSwitchPortalMode = (targetRole: UserRole, targetClass?: string) => {
    const effectiveClass = targetClass || currentClass || 'Lớp 3C';
    setUserRole(targetRole);
    setCurrentGrade('Khối 3');
    setCurrentClass(effectiveClass);
    localStorage.setItem('eduplay_active_role', targetRole);

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
