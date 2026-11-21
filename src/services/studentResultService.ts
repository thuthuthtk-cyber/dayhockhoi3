import {
  doc,
  setDoc,
  getDocFromServer,
  getDoc,
  collection,
  query,
  where,
  getDocs,
  updateDoc,
  writeBatch
} from 'firebase/firestore';
import { db } from './firebase';
import { normalizeStudentCode } from './studentCode';
import { sanitizeForFirestore, withFirestoreTimeout } from '../utils/firestoreSanitizer';

export const STUDENT_RESULTS_COLLECTION = 'student_results';

export interface StudentResultDocument {
  studentCode: string;
  updatedAt: string;
  exams?: Record<string, any>;
  assignments?: Record<string, any>;
  lessons?: Record<string, any>;
  games?: Record<string, any>;
  hocba?: Record<string, any>;
}

// Định nghĩa chính sách lưu trữ lần làm bài cho bài tập
type KeepAttemptPolicy = 'last' | 'best' | 'all';

interface AssignmentSubmissionPayload {
  assignmentId: string;
  score: number;
  maxScore: number;
  submittedAt: string;
  attemptNumber?: number;
  answers?: Record<string, any>;
  keepAttempts?: KeepAttemptPolicy;
}

/**
 * Dịch vụ quản lý kết quả học tập tập trung theo studentCode
 */
export const studentResultService = {
  /**
   * Lưu kết quả làm bài tập của học sinh
   * Nếu cấu hình keepAttempts là 'last' (lần cuối), hệ thống ghi đè kết quả mới nhất.
   */
  async saveAssignmentResult(
    rawStudentCode: string,
    payload: AssignmentSubmissionPayload
  ): Promise<boolean> {
    try {
      const studentCode = normalizeStudentCode(rawStudentCode);
      if (!studentCode) throw new Error('Mã học sinh không hợp lệ');
      if (!payload?.assignmentId) throw new Error('Mã bài tập không hợp lệ');

      const docRef = doc(db, STUDENT_RESULTS_COLLECTION, studentCode);
      const policy: KeepAttemptPolicy = payload.keepAttempts || 'last';
      const safeScore = Number.isFinite(Number(payload.score)) ? Number(payload.score) : 0;
      const safeMaxScore = Number.isFinite(Number(payload.maxScore)) ? Number(payload.maxScore) : 10;
      const safeSubmittedAt = payload.submittedAt || new Date().toISOString();
      const safeAnswers = sanitizeForFirestore(payload.answers || {});

      const assignmentData: any = {
        assignmentId: String(payload.assignmentId),
        studentCode,
        score: safeScore,
        maxScore: safeMaxScore,
        submittedAt: safeSubmittedAt,
        attemptNumber: Number.isFinite(Number(payload.attemptNumber)) ? Number(payload.attemptNumber) : 1,
      };

      // Nếu chính sách là 'last', chỉ lưu câu trả lời hoặc chi tiết của lần nộp mới nhất
      if (policy === 'last') {
        assignmentData.lastAttempt = {
          score: safeScore,
          submittedAt: safeSubmittedAt,
          answers: safeAnswers,
        };
      } else if (policy === 'best') {
        assignmentData.bestScore = safeScore;
      }

      // Cập nhật cấu trúc lồng nhau dùng dot notation qua { merge: true } để không ghi đè dữ liệu môn khác
      const updatePayload = sanitizeForFirestore({
        studentCode,
        [`assignments.${payload.assignmentId}`]: assignmentData,
        updatedAt: new Date().toISOString(),
      });

      // Thực hiện ghi an toàn bằng setDoc merge kèm timeout
      await withFirestoreTimeout(
        setDoc(docRef, updatePayload, { merge: true }),
        10000,
        'saveAssignmentResult.setDoc'
      );

      // Xác thực không chặn nếu server phản hồi chậm hoặc đang offline
      try {
        await withFirestoreTimeout(getDocFromServer(docRef), 4000, 'saveAssignmentResult.verify');
      } catch (verifyErr) {
        console.warn('Xác thực getDocFromServer tạm bỏ qua (mạng chậm/offline):', verifyErr);
      }

      return true;
    } catch (error) {
      console.error('Lỗi khi lưu kết quả bài tập:', error);
      throw error;
    }
  },

  /**
   * Lưu kết quả bài kiểm tra (Exams)
   */
  async saveExamResult(
    rawStudentCode: string,
    examId: string,
    resultData: { score: number; maxScore: number; submittedAt: string; type?: string }
  ): Promise<boolean> {
    try {
      const studentCode = normalizeStudentCode(rawStudentCode);
      if (!studentCode) throw new Error('Mã học sinh không hợp lệ');

      const docRef = doc(db, STUDENT_RESULTS_COLLECTION, studentCode);
      const safeScore = Number.isFinite(Number(resultData?.score)) ? Number(resultData.score) : 0;
      const safeMaxScore = Number.isFinite(Number(resultData?.maxScore)) ? Number(resultData.maxScore) : 10;

      const updatePayload = sanitizeForFirestore({
        studentCode,
        [`exams.${examId}`]: {
          ...resultData,
          examId,
          studentCode,
          score: safeScore,
          maxScore: safeMaxScore,
          submittedAt: resultData?.submittedAt || new Date().toISOString(),
          type: resultData?.type || 'exam',
          updatedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      });

      await withFirestoreTimeout(
        setDoc(docRef, updatePayload, { merge: true }),
        10000,
        'saveExamResult.setDoc'
      );
      return true;
    } catch (error) {
      console.error('Lỗi khi lưu kết quả kiểm tra:', error);
      throw error;
    }
  },

  /**
   * Lưu kết quả trò chơi / đấu trường (Games)
   */
  async saveGameResult(
    rawStudentCode: string,
    gameId: string,
    resultData: {
      score: number;
      maxScore: number;
      rank: number | 'unranked';
      submittedAt: string;
      completed?: boolean;
      questionsAnswered?: number;
      totalQuestions?: number;
      studentName?: string;
      className?: string;
      roomId?: string;
      roomTitle?: string;
    }
  ): Promise<boolean> {
    try {
      const studentCode = normalizeStudentCode(rawStudentCode);
      if (!studentCode) throw new Error('Mã học sinh không hợp lệ');

      const docRef = doc(db, STUDENT_RESULTS_COLLECTION, studentCode);

      const updatePayload = sanitizeForFirestore({
        studentCode,
        [`games.${gameId}`]: {
          ...resultData,
          studentCode,
          updatedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      });

      await withFirestoreTimeout(
        setDoc(docRef, updatePayload, { merge: true }),
        10000,
        'saveGameResult.setDoc'
      );
      return true;
    } catch (error) {
      console.error('Lỗi khi lưu kết quả trò chơi:', error);
      throw error;
    }
  },

  /**
   * Tải kết quả bài kiểm tra (Exams) từ Firestore
   */
  async getExamSubmission(rawStudentCode: string, examId: string): Promise<any | null> {
    try {
      const studentCode = normalizeStudentCode(rawStudentCode);
      if (!studentCode) return null;
      // Fetch from: student_results/{studentCode}/exams/{examId}
      const docRef = doc(db, STUDENT_RESULTS_COLLECTION, studentCode, 'exams', examId);
      const snap = await withFirestoreTimeout(getDoc(docRef), 8000, 'getExamSubmission');
      return snap.exists() ? snap.data() : null;
    } catch (error) {
      console.error('Lỗi khi tải bài kiểm tra từ Firestore:', error);
      return null;
    }
  },

  /**
   * Lưu toàn bộ kết quả bài kiểm tra (Exams) lên Firestore
   */
  async saveFullExamSubmission(
    rawStudentCode: string,
    examId: string,
    submissionData: any
  ): Promise<boolean> {
    try {
      const studentCode = normalizeStudentCode(rawStudentCode);
      if (!studentCode) throw new Error('Mã học sinh không hợp lệ');

      // Save to: student_results/{studentCode}/exams/{examId}
      const docRef = doc(db, STUDENT_RESULTS_COLLECTION, studentCode, 'exams', examId);
      const sanitizedPayload = sanitizeForFirestore({
        ...submissionData,
        studentCode,
        studentId: studentCode,
        examId,
        updatedAt: new Date().toISOString(),
      });

      await withFirestoreTimeout(
        setDoc(docRef, sanitizedPayload, { merge: true }),
        10000,
        'saveFullExamSubmission.setDoc'
      );
      return true;
    } catch (error) {
      console.error('Lỗi khi lưu bài kiểm tra vào Firestore:', error);
      throw error;
    }
  },

  /**
   * Lưu toàn bộ kết quả bài tập (Assignments) lên Firestore
   */
  async saveFullAssignmentSubmission(
    rawStudentCode: string,
    assignmentId: string,
    submissionData: any
  ): Promise<boolean> {
    try {
      const studentCode = normalizeStudentCode(rawStudentCode);
      if (!studentCode) throw new Error('Mã học sinh không hợp lệ');

      // Save to: student_results/{studentCode}/assignments/{assignmentId}
      const docRef = doc(db, STUDENT_RESULTS_COLLECTION, studentCode, 'assignments', assignmentId);
      const sanitizedPayload = sanitizeForFirestore({
        ...submissionData,
        studentCode,
        studentId: studentCode,
        assignmentId,
        updatedAt: new Date().toISOString(),
      });

      await withFirestoreTimeout(
        setDoc(docRef, sanitizedPayload, { merge: true }),
        10000,
        'saveFullAssignmentSubmission.setDoc'
      );
      return true;
    } catch (error) {
      console.error('Lỗi khi lưu bài tập vào Firestore:', error);
      throw error;
    }
  },

  /**
   * Xóa toàn bộ kết quả bài tập / đề kiểm tra của học sinh trong `student_results`
   * Chỉ đối chiếu theo `studentCode` đã chuẩn hóa (không phụ thuộc tên học sinh).
   */
  async deleteStudentTargetResult(
    rawStudentCode: string,
    targetIds: string | string[]
  ): Promise<{ deletedCount: number }> {
    const studentCode = normalizeStudentCode(rawStudentCode);
    if (!studentCode) throw new Error('Mã học sinh không hợp lệ');

    const rawList = Array.isArray(targetIds) ? targetIds : [targetIds];
    const cleanTargetIds = Array.from(
      new Set(rawList.map((t) => String(t || '').trim()).filter(Boolean))
    );
    if (cleanTargetIds.length === 0) {
      return { deletedCount: 0 };
    }
    const targetLowerSet = new Set(cleanTargetIds.map((t) => t.toLowerCase()));

    let deletedCount = 0;

    try {
      const candidateSrDocIds = new Set<string>([
        studentCode,
        studentCode.toLowerCase(),
      ]);

      // 1. Truy vấn trực tiếp `student_results` theo `studentCode` (hỗ trợ cả bản ghi hoa/thường)
      const srRef = collection(db, STUDENT_RESULTS_COLLECTION);
      const codeQueries = [
        query(srRef, where('studentCode', '==', studentCode)),
        query(srRef, where('studentCode', '==', studentCode.toLowerCase())),
      ];
      for (const q of codeQueries) {
        try {
          const snap = await withFirestoreTimeout(getDocs(q), 8000, 'deleteStudentTargetResult.codeQuery');
          snap.forEach((d) => candidateSrDocIds.add(d.id));
        } catch (qErr) {
          console.warn('Lỗi truy vấn student_results theo studentCode:', qErr);
        }
      }

      // 2. Truy vấn trực tiếp `student_results` theo `targetId` / `assignmentId` / `examId`
      const refsToDelete = new Map<string, ReturnType<typeof doc>>();
      for (const tid of cleanTargetIds) {
        const directTargetQueries = [
          query(srRef, where('targetId', '==', tid)),
          query(srRef, where('assignmentId', '==', tid)),
          query(srRef, where('examId', '==', tid)),
        ];
        for (const tq of directTargetQueries) {
          try {
            const snap = await withFirestoreTimeout(getDocs(tq), 8000, 'deleteStudentTargetResult.targetQuery');
            snap.forEach((d) => {
              const data = d.data() || {};
              const docCode = normalizeStudentCode(
                data.studentCode || data.code || data.maHs || data.studentId || ''
              );
              const docIdNorm = normalizeStudentCode(d.id);
              const matchesStudent =
                docCode === studentCode ||
                docIdNorm === studentCode ||
                docIdNorm.startsWith(`${studentCode}_`) ||
                docIdNorm.startsWith(`${studentCode}-`) ||
                docIdNorm.endsWith(`_${studentCode}`) ||
                docIdNorm.endsWith(`-${studentCode}`);

              if (!matchesStudent) return;

              // Nếu là hồ sơ tổng hợp của học sinh (có nhiều mục khác), đưa vào danh sách cập nhật map;
              // nếu là bản ghi kết quả đơn lẻ gắn trực tiếp targetId, đưa vào batch delete.
              const isAggregateProfile =
                docIdNorm === studentCode &&
                (typeof data.assignments === 'object' ||
                  typeof data.exams === 'object' ||
                  typeof data.lessons === 'object' ||
                  typeof data.games === 'object');

              if (isAggregateProfile) {
                candidateSrDocIds.add(d.id);
              } else {
                refsToDelete.set(d.ref.path, d.ref);
              }
            });
          } catch (tqErr) {
            console.warn(`Lỗi truy vấn student_results theo target ${tid}:`, tqErr);
          }
        }
      }

      // 3. Làm sạch map `assignments` / `exams` và subcollections `assignments` / `exams` của từng `student_results/{srDocId}`
      for (const srDocId of candidateSrDocIds) {
        const srDocRef = doc(db, STUDENT_RESULTS_COLLECTION, srDocId);
        try {
          const srSnap = await withFirestoreTimeout(getDoc(srDocRef), 8000, 'deleteStudentTargetResult.getProfile');
          if (srSnap.exists()) {
            const data = srSnap.data() || {};
            const docCode = normalizeStudentCode(data.studentCode || srSnap.id || '');
            if (docCode === studentCode || normalizeStudentCode(srSnap.id) === studentCode) {
              const updatePayload: Record<string, any> = {};
              let modified = false;

              if (data.assignments && typeof data.assignments === 'object') {
                const nextAssignments = { ...data.assignments };
                for (const [k, v] of Object.entries<any>(nextAssignments)) {
                  const keyLower = k.trim().toLowerCase();
                  const valTid = String(v?.assignmentId || v?.targetId || v?.id || '').trim().toLowerCase();
                  if (targetLowerSet.has(keyLower) || (valTid && targetLowerSet.has(valTid))) {
                    delete nextAssignments[k];
                    modified = true;
                    deletedCount++;
                  }
                }
                if (modified) {
                  updatePayload.assignments = nextAssignments;
                }
              }

              if (data.exams && typeof data.exams === 'object') {
                const nextExams = { ...data.exams };
                let examModified = false;
                for (const [k, v] of Object.entries<any>(nextExams)) {
                  const keyLower = k.trim().toLowerCase();
                  const valTid = String(v?.examId || v?.targetId || v?.assignmentId || v?.id || '').trim().toLowerCase();
                  if (targetLowerSet.has(keyLower) || (valTid && targetLowerSet.has(valTid))) {
                    delete nextExams[k];
                    examModified = true;
                    deletedCount++;
                  }
                }
                if (examModified) {
                  updatePayload.exams = nextExams;
                  modified = true;
                }
              }

              if (modified) {
                updatePayload.updatedAt = new Date().toISOString();
                await withFirestoreTimeout(updateDoc(srDocRef, updatePayload), 8000, 'deleteStudentTargetResult.updateProfile');
              }
            }
          }
        } catch (profileErr) {
          console.warn(`Lỗi cập nhật hồ sơ student_results/${srDocId}:`, profileErr);
        }

        // Quét & xóa trong 2 subcollection `assignments` và `exams`
        for (const subName of ['assignments', 'exams'] as const) {
          const subColRef = collection(db, STUDENT_RESULTS_COLLECTION, srDocId, subName);
          try {
            const subSnap = await withFirestoreTimeout(getDocs(subColRef), 8000, `deleteStudentTargetResult.sub.${subName}`);
            subSnap.forEach((docSnap) => {
              const sData = docSnap.data() || {};
              const idLower = docSnap.id.trim().toLowerCase();
              const fieldIds = [sData.assignmentId, sData.examId, sData.targetId, sData.id]
                .filter(Boolean)
                .map((x) => String(x).trim().toLowerCase());
              if (targetLowerSet.has(idLower) || fieldIds.some((fid) => targetLowerSet.has(fid))) {
                refsToDelete.set(docSnap.ref.path, docSnap.ref);
              }
            });
          } catch (subErr) {
            console.warn(`Lỗi đọc subcollection student_results/${srDocId}/${subName}:`, subErr);
          }

          // Truy vấn trực tiếp bằng where('assignmentId' / 'targetId') phòng trường hợp cần index/direct match
          for (const tid of cleanTargetIds) {
            for (const field of ['targetId', 'assignmentId', 'examId'] as const) {
              try {
                const qSub = query(subColRef, where(field, '==', tid));
                const qSnap = await withFirestoreTimeout(getDocs(qSub), 8000, `deleteStudentTargetResult.qSub.${field}`);
                qSnap.forEach((docSnap) => {
                  refsToDelete.set(docSnap.ref.path, docSnap.ref);
                });
              } catch {}
            }
          }
        }
      }

      // 4. Thực thi xóa hàng loạt bằng writeBatch
      const allRefs = Array.from(refsToDelete.values());
      const CHUNK_SIZE = 450;
      for (let i = 0; i < allRefs.length; i += CHUNK_SIZE) {
        const chunk = allRefs.slice(i, i + CHUNK_SIZE);
        const batch = writeBatch(db);
        chunk.forEach((r) => batch.delete(r));
        await withFirestoreTimeout(batch.commit(), 10000, 'deleteStudentTargetResult.batchCommit');
        deletedCount += chunk.length;
      }

      return { deletedCount };
    } catch (error) {
      console.error('Lỗi khi xóa kết quả học sinh trên student_results:', error);
      throw error;
    }
  }
};


