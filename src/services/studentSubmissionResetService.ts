import { db } from './firebase';
import {
  doc,
  deleteDoc,
  getDoc,
  updateDoc,
  collection,
  getDocs,
  query,
  where,
  writeBatch,
  DocumentReference
} from 'firebase/firestore';
import { normalizeStudentCode } from './studentCode';
import { deleteExamDraft } from './examDraftService';
import { invalidateAllSubmissionsCache } from './hocBaDataService';
import { normalizeClassKey } from './studentSessionService';
import { backupSubmissionBeforeDelete } from './unmatchedSubmissionsService';
import { studentResultService } from './studentResultService';
import { clearMemoryTrackingData, clearIndexedDBTrackingData } from './assignmentTrackingData';
import { getLocalCachedAssignments, saveAssignmentsToLocalStorage } from './assignmentStorageService';
import { withFirestoreTimeout } from '../utils/firestoreSanitizer';

export interface ResetSubmissionOptions {
  studentCode: string;
  studentName?: string;
  studentId?: string;
  examId: string;
  originalExamId?: string;
  targetClass?: string;
  extraCandidateIds?: string[];
}

export interface ResetAssignmentSubmissionOptions {
  studentCode: string;
  studentName?: string;
  studentId?: string;
  assignmentId: string;
  originalAssignmentId?: string;
  targetClass?: string;
  extraCandidateIds?: string[];
}

/**
 * Xây dựng tập hợp mã học sinh chuẩn hóa (KHÔNG dùng tên học sinh để tránh trùng tên).
 */
function buildNormalizedCodeSet(primaryCode: string, extras: Array<string | undefined | null> = []): Set<string> {
  const set = new Set<string>();
  const add = (val?: string | null) => {
    if (!val || typeof val !== 'string') return;
    const norm = normalizeStudentCode(val);
    if (norm) set.add(norm);
  };
  add(primaryCode);
  extras.forEach(add);
  return set;
}

/**
 * Kiểm tra docId hoặc dữ liệu bản ghi có khớp studentCode hay không (có biên giới ký tự để tránh '3C26-27-1' khớp nhầm '3C26-27-10').
 */
function isDocMatchedByStudentCode(
  docId: string,
  data: Record<string, any> | undefined,
  codeSet: Set<string>,
  exactRawDocIds: Set<string>
): boolean {
  const cleanDocId = String(docId || '').trim();
  const lowerDocId = cleanDocId.toLowerCase();

  if (lowerDocId && exactRawDocIds.has(lowerDocId)) {
    return true;
  }

  const normDocId = normalizeStudentCode(cleanDocId);
  for (const code of codeSet) {
    if (!code) continue;
    if (normDocId === code) return true;
    if (
      normDocId.startsWith(`${code}_`) ||
      normDocId.startsWith(`${code}-`) ||
      normDocId.endsWith(`_${code}`) ||
      normDocId.endsWith(`-${code}`) ||
      normDocId.includes(`_${code}_`) ||
      normDocId.includes(`-${code}-`) ||
      normDocId.includes(`-${code}_`) ||
      normDocId.includes(`_${code}-`)
    ) {
      return true;
    }
  }

  if (data) {
    const fieldValues = [
      data.studentCode,
      data.code,
      data.maHs,
      data.studentId,
      data.userId,
      data.sddcn,
      data.studentPersistentId
    ];
    for (const fv of fieldValues) {
      if (fv && typeof fv === 'string') {
        const normFv = normalizeStudentCode(fv);
        if (normFv && codeSet.has(normFv)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Kiểm tra phần tử trong mảng `submissions` có thuộc học sinh có mã trong `codeSet` hay không (strictly by studentCode / submission id, NEVER by studentName).
 */
function isSubmissionArrayItemMatched(
  item: any,
  codeSet: Set<string>,
  exactRawSubIds: Set<string>
): boolean {
  if (!item || typeof item !== 'object') return false;
  const itemIdLower = String(item.id || '').trim().toLowerCase();
  if (itemIdLower && exactRawSubIds.has(itemIdLower)) {
    return true;
  }
  return isDocMatchedByStudentCode(String(item.id || ''), item, codeSet, exactRawSubIds);
}

/**
 * Xóa danh sách DocumentReference bằng writeBatch (chia chunk <= 450).
 */
async function commitBatchDeletes(refs: DocumentReference[]): Promise<number> {
  if (!db || refs.length === 0) return 0;
  let total = 0;
  const CHUNK_SIZE = 450;
  for (let i = 0; i < refs.length; i += CHUNK_SIZE) {
    const chunk = refs.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);
    chunk.forEach((ref) => batch.delete(ref));
    await withFirestoreTimeout(batch.commit(), 10000, 'commitBatchDeletes');
    total += chunk.length;
  }
  return total;
}

/**
 * Xóa triệt để và đồng bộ toàn bộ dữ liệu bài làm của học sinh cho đề kiểm tra trên Firestore & LocalStorage
 * Chỉ định danh theo `studentCode` đã chuẩn hóa (không phụ thuộc tên học sinh).
 */
export async function resetOrDeleteStudentExamSubmission(
  options: ResetSubmissionOptions
): Promise<{ success: boolean; deletedCount: number }> {
  const { studentCode, studentId, examId, originalExamId, targetClass, extraCandidateIds = [] } = options;
  const normCode = normalizeStudentCode(studentCode || studentId || '');
  if (!normCode) {
    throw new Error('Mã học sinh không hợp lệ.');
  }
  if (!examId) {
    throw new Error('Mã đề kiểm tra không hợp lệ.');
  }

  const codeSet = buildNormalizedCodeSet(normCode, [studentId, ...extraCandidateIds]);
  const exactRawSubIds = new Set<string>(
    [normCode, studentId, ...extraCandidateIds]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim().toLowerCase())
  );

  const classKey = normalizeClassKey(targetClass || '').toLowerCase();
  const examBaseId = (originalExamId || examId || '').replace(/^ex-/, '').replace(/^as-/, '').replace(/-class-.*$/, '');

  const candDocIds = Array.from(new Set([
    examId,
    examBaseId ? `ex-${examBaseId}-class-${classKey}` : '',
    examBaseId ? `ex-${examBaseId}-class-lp${classKey}` : '',
    originalExamId
  ].filter(Boolean) as string[]));

  let deletedCount = 0;

  if (db) {
    for (const docId of candDocIds) {
      try {
        const refsToDelete = new Map<string, DocumentReference>();

        // A. Xóa trong subcollection 'exams/{docId}/submissions'
        const subColRef = collection(db, 'exams', docId, 'submissions');
        const subSnap = await withFirestoreTimeout(getDocs(subColRef), 10000, `examReset.getSubs.${docId}`);
        subSnap.forEach((docSnap) => {
          if (isDocMatchedByStudentCode(docSnap.id, docSnap.data(), codeSet, exactRawSubIds)) {
            refsToDelete.set(docSnap.ref.path, docSnap.ref);
          }
        });

        // Kiểm tra các doc ID cố định nếu có chưa nằm trong snapshot
        const deterministicIds = [
          normCode,
          normCode.toLowerCase(),
          `${normCode}_${docId}_1`,
          `sub-${docId}-${normCode}`
        ];
        for (const detId of deterministicIds) {
          const detRef = doc(db, 'exams', docId, 'submissions', detId);
          if (!refsToDelete.has(detRef.path)) {
            try {
              const detSnap = await withFirestoreTimeout(getDoc(detRef), 5000, `examReset.det.${detId}`);
              if (detSnap.exists()) {
                refsToDelete.set(detRef.path, detRef);
              }
            } catch {}
          }
        }

        deletedCount += await commitBatchDeletes(Array.from(refsToDelete.values()));

        // B. Cập nhật mảng submissions trên master document exams/{docId}
        const masterRef = doc(db, 'exams', docId);
        const masterSnap = await withFirestoreTimeout(getDoc(masterRef), 8000, `examReset.master.${docId}`);
        if (masterSnap.exists()) {
          const masterData = masterSnap.data();
          if (Array.isArray(masterData.submissions)) {
            const filteredSubs = masterData.submissions.filter(
              (s: any) => !isSubmissionArrayItemMatched(s, codeSet, exactRawSubIds)
            );
            if (filteredSubs.length !== masterData.submissions.length) {
              await withFirestoreTimeout(
                updateDoc(masterRef, {
                  submissions: filteredSubs,
                  updatedAt: new Date().toISOString()
                }),
                8000,
                `examReset.updateMaster.${docId}`
              );
              deletedCount++;
            }
          }
        }

        // C. Kiểm tra đồng bộ ở collection assignments nếu có
        try {
          const asColRef = collection(db, 'assignments', docId, 'submissions');
          const asSnap = await withFirestoreTimeout(getDocs(asColRef), 8000, `examReset.asSubs.${docId}`);
          const asRefs: DocumentReference[] = [];
          asSnap.forEach((docSnap) => {
            if (isDocMatchedByStudentCode(docSnap.id, docSnap.data(), codeSet, exactRawSubIds)) {
              asRefs.push(docSnap.ref);
            }
          });
          deletedCount += await commitBatchDeletes(asRefs);

          const asMasterRef = doc(db, 'assignments', docId);
          const asMasterSnap = await withFirestoreTimeout(getDoc(asMasterRef), 8000, `examReset.asMaster.${docId}`);
          if (asMasterSnap.exists()) {
            const asData = asMasterSnap.data();
            if (Array.isArray(asData.submissions)) {
              const filteredAsSubs = asData.submissions.filter(
                (s: any) => !isSubmissionArrayItemMatched(s, codeSet, exactRawSubIds)
              );
              if (filteredAsSubs.length !== asData.submissions.length) {
                await withFirestoreTimeout(
                  updateDoc(asMasterRef, {
                    submissions: filteredAsSubs,
                    updatedAt: new Date().toISOString()
                  }),
                  8000,
                  `examReset.updateAsMaster.${docId}`
                );
              }
            }
          }
        } catch {}
      } catch (err: any) {
        console.error(`Lỗi khi dọn dẹp Firestore cho exam ${docId}:`, err);
        throw new Error(`Lỗi cơ sở dữ liệu: ${err?.message || 'Không thể xóa bài làm'}`);
      }
    }

    // D. Xóa trong `student_results` theo studentCode
    for (const c of codeSet) {
      try {
        const srRes = await studentResultService.deleteStudentTargetResult(c, candDocIds);
        deletedCount += srRes.deletedCount;
      } catch (srErr) {
        console.warn(`Lỗi cập nhật student_results cho ${c} khi xóa bài thi:`, srErr);
      }
    }

    // E. Xóa bản nháp `exam_drafts` & tiến độ `exam_progress`
    for (const docId of candDocIds) {
      for (const c of codeSet) {
        await deleteExamDraft(c, docId).catch(() => {});
        try {
          await deleteDoc(doc(db, 'exam_drafts', `${c}_${docId}`));
        } catch {}
        try {
          await deleteDoc(doc(db, 'exam_progress', `${c}_${docId}`));
        } catch {}
      }
    }
  }

  // 2. Dọn dẹp triệt để trong LocalStorage
  if (typeof window !== 'undefined') {
    try {
      const targetLowerSet = new Set(candDocIds.map((id) => id.toLowerCase()));
      const studentKeys = Array.from(new Set([normCode, studentId, studentCode, ...extraCandidateIds].filter(Boolean) as string[]));
      studentKeys.forEach((k) => {
        localStorage.removeItem(`eduplay_student_exam_subs_${k}`);
        localStorage.removeItem(`eduplay_student_exam_submissions_${k}`);
        localStorage.removeItem(`eduplay_student_submissions_${k}`);
      });

      candDocIds.forEach((docId) => {
        localStorage.removeItem(`eduplay_exam_subs_${docId}`);
        studentKeys.forEach((k) => {
          localStorage.removeItem(`eduplay_exam_draft_${k}_${docId}`);
        });
      });

      const allSubsRaw = localStorage.getItem('eduplay_all_exam_submissions');
      if (allSubsRaw) {
        const allSubs = JSON.parse(allSubsRaw);
        if (Array.isArray(allSubs)) {
          const filtered = allSubs.filter((s: any) => {
            const sCode = normalizeStudentCode(s?.studentCode || s?.code || s?.maHs || s?.studentId || '');
            const sExamId = String(s?.examId || s?.targetId || s?.id || s?.exam?.id || '').trim().toLowerCase();
            const isMatchExam = targetLowerSet.has(sExamId) || candDocIds.some((cid) => sExamId.includes(cid.toLowerCase()));
            if (codeSet.has(sCode) && isMatchExam) return false;
            return true;
          });
          localStorage.setItem('eduplay_all_exam_submissions', JSON.stringify(filtered));
        }
      }

      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('eduplay_student_exam_subs_') || k.startsWith('eduplay_student_exam_submissions_'))) {
          const raw = localStorage.getItem(k);
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                const cleaned = parsed.filter((item: any) => {
                  const itemExamId = String(item?.examId || item?.targetId || item?.id || item?.exam?.id || '').toLowerCase();
                  const itemCode = normalizeStudentCode(item?.studentCode || item?.code || item?.maHs || item?.studentId || '');
                  const isMatchExam = targetLowerSet.has(itemExamId) || candDocIds.some((cid) => itemExamId.includes(cid.toLowerCase()));
                  if ((codeSet.has(itemCode) || codeSet.has(normalizeStudentCode(k.split('_').pop()))) && isMatchExam) {
                    return false;
                  }
                  return true;
                });
                localStorage.setItem(k, JSON.stringify(cleaned));
              }
            } catch {}
          }
        }
      }
    } catch (lsErr) {
      console.warn('Lỗi dọn LocalStorage khi xóa bài:', lsErr);
    }
  }

  try {
    invalidateAllSubmissionsCache();
  } catch {}

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('eduplay_exam_submissions_updated'));
    window.dispatchEvent(new Event('eduplay_student_submissions_updated'));
    window.dispatchEvent(new Event('storage'));
    window.dispatchEvent(new CustomEvent('eduplay_submission_reset', {
      detail: {
        studentCode: normCode,
        examId,
        candDocIds
      }
    }));
  }

  return { success: true, deletedCount };
}

/**
 * Xóa một bài nộp chưa khớp (orphaned/unmatched submission) cụ thể trên Firestore
 */
export async function deleteSingleUnmatchedSubmission(
  examId: string,
  submissionDocId: string,
  rawStudentCode?: string
): Promise<boolean> {
  if (!db || !examId || !submissionDocId) return false;

  try {
    try {
      const snap = await getDoc(doc(db, 'exams', examId, 'submissions', submissionDocId));
      if (snap.exists()) {
        await backupSubmissionBeforeDelete(examId, submissionDocId, snap.data(), 'single_unmatched_delete');
      }
    } catch (bErr) {
      console.warn('Lỗi sao lưu trước khi xóa đơn:', bErr);
    }

    await deleteDoc(doc(db, 'exams', examId, 'submissions', submissionDocId));

    const masterRef = doc(db, 'exams', examId);
    const snap = await getDoc(masterRef);
    if (snap.exists()) {
      const data = snap.data();
      if (Array.isArray(data.submissions)) {
        const normTarget = rawStudentCode ? normalizeStudentCode(rawStudentCode) : '';
        const filtered = data.submissions.filter((s: any) => {
          if (s.id === submissionDocId) return false;
          if (normTarget && normalizeStudentCode(s.studentCode || s.studentId || s.maHs || '') === normTarget) return false;
          return true;
        });
        await updateDoc(masterRef, {
          submissions: filtered,
          updatedAt: new Date().toISOString()
        });
      }
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('eduplay_exam_submissions_updated'));
      window.dispatchEvent(new Event('storage'));
    }

    return true;
  } catch (err) {
    console.error('Lỗi khi xóa bài nộp chưa khớp:', err);
    throw err;
  }
}

/**
 * Dọn dẹp hàng loạt toàn bộ bài nộp chưa khớp (không thuộc danh sách lớp)
 */
export async function cleanAllUnmatchedExamSubmissions(
  examId: string,
  validRosterCodes: string[],
  additionalExamIds?: string[]
): Promise<{ deletedCount: number }> {
  if (!db || !examId) return { deletedCount: 0 };

  const validSet = new Set(validRosterCodes.map((c) => normalizeStudentCode(c)));
  const allExamIds = Array.from(new Set([examId, ...(additionalExamIds || [])].filter(Boolean) as string[]));
  let totalDeleted = 0;

  for (const exId of allExamIds) {
    try {
      const subColRef = collection(db, 'exams', exId, 'submissions');
      const subSnap = await getDocs(subColRef);

      const deletePromises: Promise<any>[] = [];
      subSnap.forEach((docSnap) => {
        const data = docSnap.data();
        const code = normalizeStudentCode(data.studentCode || data.code || data.maHs || data.studentId || docSnap.id || '');
        if (!validSet.has(code)) {
          deletePromises.push(
            (async () => {
              await backupSubmissionBeforeDelete(exId, docSnap.id, data, 'clean_all_unmatched');
              await deleteDoc(doc(db, 'exams', exId, 'submissions', docSnap.id));
              totalDeleted++;
            })().catch(() => {})
          );
        }
      });

      await Promise.all(deletePromises);

      const masterRef = doc(db, 'exams', exId);
      const masterSnap = await getDoc(masterRef);
      if (masterSnap.exists()) {
        const data = masterSnap.data();
        if (Array.isArray(data.submissions)) {
          const filtered = data.submissions.filter((s: any) => {
            const code = normalizeStudentCode(s.studentCode || s.code || s.maHs || s.studentId || s.id || '');
            return validSet.has(code);
          });
          await updateDoc(masterRef, {
            submissions: filtered,
            updatedAt: new Date().toISOString()
          });
        }
      }
    } catch (err) {
      console.error(`Lỗi khi dọn dẹp submissions cho ${exId}:`, err);
    }
  }

  if (typeof window !== 'undefined') {
    try {
      const allRaw = localStorage.getItem('eduplay_all_exam_submissions');
      if (allRaw) {
        const parsed = JSON.parse(allRaw);
        if (Array.isArray(parsed)) {
          const cleaned = parsed.filter((item: any) => {
            const code = normalizeStudentCode(item.studentCode || item.code || item.maHs || item.studentId || '');
            const isMatchExam = allExamIds.some((id) => String(item.examId || '').includes(id));
            if (isMatchExam && !validSet.has(code)) return false;
            return true;
          });
          localStorage.setItem('eduplay_all_exam_submissions', JSON.stringify(cleaned));
        }
      }
      for (const exId of allExamIds) {
        localStorage.removeItem(`eduplay_exam_subs_${exId}`);
      }
    } catch {}
    try {
      invalidateAllSubmissionsCache();
    } catch {}
    window.dispatchEvent(new Event('eduplay_exam_submissions_updated'));
    window.dispatchEvent(new Event('storage'));
  }

  return { deletedCount: totalDeleted };
}

/**
 * Xóa triệt để và đồng bộ toàn bộ dữ liệu bài làm của học sinh cho bài tập rèn luyện trên Firestore & LocalStorage.
 * Quy tắc nghiêm ngặt:
 * - Định danh duy nhất bằng `studentCode` đã chuẩn hóa (`trim().toUpperCase()`), KHÔNG phụ thuộc tên học sinh.
 * - Truy vấn trực tiếp Firestore (`assignments/{id}/submissions`, `assignments/{id}`, `student_results`, `submissions`, `exams/{id}/submissions`, `quiz_live_sessions`, `score_records`, `exam_drafts`) và xóa bằng `writeBatch` / `deleteDoc` trong `try/catch`.
 * - Xóa sạch LocalStorage, cache bộ nhớ/IndexedDB và phát sự kiện đồng bộ tức thì.
 */
export async function resetOrDeleteStudentAssignmentSubmission(
  options: ResetAssignmentSubmissionOptions
): Promise<{ success: boolean; deletedCount: number }> {
  const {
    studentCode,
    studentId,
    assignmentId,
    originalAssignmentId,
    targetClass,
    extraCandidateIds = []
  } = options;

  const normCode = normalizeStudentCode(studentCode || studentId || '');
  if (!normCode) {
    throw new Error('Mã học sinh không hợp lệ.');
  }
  if (!assignmentId) {
    throw new Error('Mã bài tập không hợp lệ.');
  }

  const codeSet = buildNormalizedCodeSet(normCode, [studentId, ...extraCandidateIds]);
  const exactRawSubIds = new Set<string>(
    [normCode, studentId, ...extraCandidateIds]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim().toLowerCase())
  );

  const classKey = normalizeClassKey(targetClass || '').toLowerCase();
  const assignBaseId = (originalAssignmentId || assignmentId || '')
    .replace(/^as-/, '')
    .replace(/^ex-/, '')
    .replace(/-class-.*$/, '');

  const candDocIds = Array.from(
    new Set(
      [
        assignmentId,
        originalAssignmentId,
        assignBaseId && classKey ? `as-${assignBaseId}-class-${classKey}` : '',
        assignBaseId && classKey ? `as-${assignBaseId}-class-lp${classKey}` : '',
        assignBaseId && classKey ? `ex-${assignBaseId}-class-${classKey}` : '',
        assignBaseId && classKey ? `ex-${assignBaseId}-class-lp${classKey}` : '',
        assignmentId.startsWith('ex-') ? assignmentId.replace(/^ex-/, 'as-') : '',
        assignmentId.startsWith('as-') ? assignmentId.replace(/^as-/, 'ex-') : ''
      ].filter(Boolean) as string[]
    )
  );

  let deletedCount = 0;

  // 1. Xóa triệt để trên Firestore
  if (db) {
    // 1A. Subcollection `assignments/{docId}/submissions` và master doc `assignments/{docId}`
    for (const docId of candDocIds) {
      try {
        const subColRef = collection(db, 'assignments', docId, 'submissions');
        const refsToDelete = new Map<string, DocumentReference>();

        // Quét toàn bộ subcollection `assignments/{docId}/submissions`
        const subSnap = await withFirestoreTimeout(
          getDocs(subColRef),
          10000,
          `assignmentReset.getSubs.${docId}`
        );
        subSnap.forEach((docSnap) => {
          if (isDocMatchedByStudentCode(docSnap.id, docSnap.data(), codeSet, exactRawSubIds)) {
            refsToDelete.set(docSnap.ref.path, docSnap.ref);
          }
        });

        // Truy vấn trực tiếp theo `assignmentId` / `targetId` trong subcollection phòng trường hợp cache/index
        for (const field of ['assignmentId', 'targetId'] as const) {
          try {
            const qSub = query(subColRef, where(field, '==', docId));
            const qSnap = await withFirestoreTimeout(getDocs(qSub), 8000, `assignmentReset.qSub.${field}`);
            qSnap.forEach((docSnap) => {
              if (isDocMatchedByStudentCode(docSnap.id, docSnap.data(), codeSet, exactRawSubIds)) {
                refsToDelete.set(docSnap.ref.path, docSnap.ref);
              }
            });
          } catch {}
        }

        // Kiểm tra các doc ID xác định nếu tồn tại trên server
        const deterministicIds = Array.from(
          new Set([
            normCode,
            normCode.toLowerCase(),
            `${normCode}_${docId}_1`,
            `sub-${docId}-${normCode}`,
            ...Array.from(exactRawSubIds)
          ])
        );
        for (const detId of deterministicIds) {
          if (!detId) continue;
          const detRef = doc(db, 'assignments', docId, 'submissions', detId);
          if (!refsToDelete.has(detRef.path)) {
            try {
              const detSnap = await withFirestoreTimeout(getDoc(detRef), 5000, `assignmentReset.det.${detId}`);
              if (detSnap.exists() && isDocMatchedByStudentCode(detSnap.id, detSnap.data(), codeSet, exactRawSubIds)) {
                refsToDelete.set(detRef.path, detRef);
              }
            } catch {}
          }
        }

        deletedCount += await commitBatchDeletes(Array.from(refsToDelete.values()));

        // Cập nhật master document `assignments/{docId}`
        const masterRef = doc(db, 'assignments', docId);
        const masterSnap = await withFirestoreTimeout(getDoc(masterRef), 8000, `assignmentReset.master.${docId}`);
        if (masterSnap.exists()) {
          const masterData = masterSnap.data() || {};
          const origSubs = Array.isArray(masterData.submissions) ? masterData.submissions : [];
          const origSubmittedIds = Array.isArray(masterData.submittedIds) ? masterData.submittedIds : [];

          const filteredSubs = origSubs.filter(
            (s: any) => !isSubmissionArrayItemMatched(s, codeSet, exactRawSubIds)
          );
          const filteredSubmittedIds = origSubmittedIds.filter((idVal: any) => {
            const normVal = normalizeStudentCode(String(idVal || ''));
            return !normVal || !codeSet.has(normVal);
          });

          const subsChanged = filteredSubs.length !== origSubs.length;
          const idsChanged = filteredSubmittedIds.length !== origSubmittedIds.length;

          if (subsChanged || idsChanged) {
            const uniqueCodeKeys = new Set<string>(
              filteredSubs
                .map((s: any) =>
                  normalizeStudentCode(s?.studentCode || s?.maHs || s?.studentId || s?.code || '')
                )
                .filter(Boolean)
            );
            filteredSubmittedIds.forEach((idVal: any) => {
              const normVal = normalizeStudentCode(String(idVal || ''));
              if (normVal) uniqueCodeKeys.add(normVal);
            });
            const count = uniqueCodeKeys.size;

            await withFirestoreTimeout(
              updateDoc(masterRef, {
                submissions: filteredSubs,
                submittedIds: Array.from(uniqueCodeKeys),
                completedCount: count,
                submittedCount: count,
                updatedAt: new Date().toISOString()
              }),
              8000,
              `assignmentReset.updateMaster.${docId}`
            );
            deletedCount++;
          }
        }
      } catch (err: any) {
        console.error(`Lỗi khi dọn dẹp Firestore cho assignment ${docId}:`, err);
        throw new Error(`Không thể xóa kết quả bài tập trên máy chủ: ${err?.message || 'Lỗi Firestore'}`);
      }

      // 1B. Collection `exams/{docId}/submissions` và master doc `exams/{docId}` (StudentExamModule đồng bộ chéo)
      try {
        const exSubColRef = collection(db, 'exams', docId, 'submissions');
        const exSubSnap = await withFirestoreTimeout(getDocs(exSubColRef), 8000, `assignmentReset.exSubs.${docId}`);
        const exRefs: DocumentReference[] = [];
        exSubSnap.forEach((docSnap) => {
          if (isDocMatchedByStudentCode(docSnap.id, docSnap.data(), codeSet, exactRawSubIds)) {
            exRefs.push(docSnap.ref);
          }
        });
        deletedCount += await commitBatchDeletes(exRefs);

        const exMasterRef = doc(db, 'exams', docId);
        const exMasterSnap = await withFirestoreTimeout(getDoc(exMasterRef), 8000, `assignmentReset.exMaster.${docId}`);
        if (exMasterSnap.exists()) {
          const exData = exMasterSnap.data() || {};
          if (Array.isArray(exData.submissions)) {
            const filteredExSubs = exData.submissions.filter(
              (s: any) => !isSubmissionArrayItemMatched(s, codeSet, exactRawSubIds)
            );
            if (filteredExSubs.length !== exData.submissions.length) {
              await withFirestoreTimeout(
                updateDoc(exMasterRef, {
                  submissions: filteredExSubs,
                  updatedAt: new Date().toISOString()
                }),
                8000,
                `assignmentReset.updateExMaster.${docId}`
              );
              deletedCount++;
            }
          }
        }
      } catch (exErr) {
        console.warn(`Bỏ qua dọn dẹp phụ exams/${docId}:`, exErr);
      }
    }

    // 1C. Xóa trong `student_results` (hồ sơ học sinh + subcollections `assignments`/`exams` + truy vấn `targetId`/`assignmentId`)
    for (const c of codeSet) {
      const srResult = await studentResultService.deleteStudentTargetResult(c, candDocIds);
      deletedCount += srResult.deletedCount;
    }

    // 1D. Truy vấn & xóa trên các collection phụ liên quan theo `targetId` / `assignmentId`
    const auxRefs = new Map<string, DocumentReference>();
    for (const tid of candDocIds) {
      // Collection `submissions` (legacy/flat submissions)
      for (const field of ['assignmentId', 'targetId', 'examId'] as const) {
        try {
          const qTopSubs = query(collection(db, 'submissions'), where(field, '==', tid));
          const snap = await withFirestoreTimeout(getDocs(qTopSubs), 8000, `assignmentReset.topSubs.${field}`);
          snap.forEach((d) => {
            if (isDocMatchedByStudentCode(d.id, d.data(), codeSet, exactRawSubIds)) {
              auxRefs.set(d.ref.path, d.ref);
            }
          });
        } catch {}
      }

      // Collection `quiz_live_sessions` (real-time leaderboard)
      try {
        const qLive = query(collection(db, 'quiz_live_sessions'), where('targetId', '==', tid));
        const liveSnap = await withFirestoreTimeout(getDocs(qLive), 8000, `assignmentReset.liveQuiz.${tid}`);
        liveSnap.forEach((d) => {
          if (isDocMatchedByStudentCode(d.id, d.data(), codeSet, exactRawSubIds)) {
            auxRefs.set(d.ref.path, d.ref);
          }
        });
      } catch {}

      // Collection `score_records`
      for (const field of ['sourceId', 'assignmentId', 'targetId'] as const) {
        try {
          const qScore = query(collection(db, 'score_records'), where(field, '==', tid));
          const scoreSnap = await withFirestoreTimeout(getDocs(qScore), 8000, `assignmentReset.scoreRecords.${field}`);
          scoreSnap.forEach((d) => {
            if (isDocMatchedByStudentCode(d.id, d.data(), codeSet, exactRawSubIds)) {
              auxRefs.set(d.ref.path, d.ref);
            }
          });
        } catch {}
      }

      // Collection `exam_drafts` và `exam_progress`
      for (const c of codeSet) {
        await deleteExamDraft(c, tid).catch(() => {});
        try {
          const draftRef = doc(db, 'exam_drafts', `${c}_${tid}`);
          const dSnap = await getDoc(draftRef);
          if (dSnap.exists()) auxRefs.set(draftRef.path, draftRef);
        } catch {}
        try {
          const progRef = doc(db, 'exam_progress', `${c}_${tid}`);
          const pSnap = await getDoc(progRef);
          if (pSnap.exists()) auxRefs.set(progRef.path, progRef);
        } catch {}
      }
    }

    if (auxRefs.size > 0) {
      try {
        deletedCount += await commitBatchDeletes(Array.from(auxRefs.values()));
      } catch (auxErr) {
        console.warn('Cảnh báo khi dọn dẹp collection phụ:', auxErr);
      }
    }
  }

  // 2. Dọn dẹp triệt để trong LocalStorage (không phụ thuộc hoa/thường)
  if (typeof window !== 'undefined') {
    try {
      const targetLowerSet = new Set(candDocIds.map((id) => id.toLowerCase()));

      const matchesTargetItem = (item: any): boolean => {
        if (!item || typeof item !== 'object') return false;
        const itemTargets = [
          item.assignmentId,
          item.targetId,
          item.examId,
          item.id,
          item.assignment?.id,
          item.exam?.id
        ]
          .filter(Boolean)
          .map((x) => String(x).trim().toLowerCase());
        return itemTargets.some((t) => targetLowerSet.has(t));
      };

      const filterSubmissionArrayByCodeAndTarget = (arr: any[], keyImpliesStudent = false): any[] => {
        return arr.filter((item: any) => {
          if (!item) return false;
          const itemCode = normalizeStudentCode(
            item.studentCode || item.code || item.maHs || item.studentId || item.userId || ''
          );
          const itemMatchesStudent =
            keyImpliesStudent ||
            (itemCode ? codeSet.has(itemCode) : false) ||
            isSubmissionArrayItemMatched(item, codeSet, exactRawSubIds);
          if (itemMatchesStudent && matchesTargetItem(item)) {
            return false;
          }
          return true;
        });
      };

      // Quét toàn bộ key bài nộp cá nhân của học sinh (`eduplay_student_submissions_*`, `eduplay_student_exam_subs_*`)
      const allKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) allKeys.push(k);
      }

      allKeys.forEach((k) => {
        if (
          k.startsWith('eduplay_student_submissions_') ||
          k.startsWith('eduplay_student_exam_subs_') ||
          k.startsWith('eduplay_student_exam_submissions_')
        ) {
          const suffix = k
            .replace(/^eduplay_student_submissions_/, '')
            .replace(/^eduplay_student_exam_subs_/, '')
            .replace(/^eduplay_student_exam_submissions_/, '');
          const normSuffix = normalizeStudentCode(suffix);
          const keyMatchesStudent = codeSet.has(normSuffix) || exactRawSubIds.has(suffix.toLowerCase());

          const raw = localStorage.getItem(k);
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                const cleaned = filterSubmissionArrayByCodeAndTarget(parsed, keyMatchesStudent);
                localStorage.setItem(k, JSON.stringify(cleaned));
              }
            } catch {}
          }
        } else if (k.startsWith('eduplay_live_quiz_')) {
          const lowerKey = k.toLowerCase();
          const matchesTarget = candDocIds.some((cid) => lowerKey.includes(cid.toLowerCase()));
          const matchesStudent = Array.from(codeSet).some((c) => lowerKey.includes(c.toLowerCase()));
          if (matchesTarget && matchesStudent) {
            localStorage.removeItem(k);
          }
        }
      });

      // Dọn các mảng tổng hợp toàn cục trong LocalStorage
      const globalListKeys = [
        'eduplay_all_assignment_submissions',
        'eduplay_all_homework_submissions',
        'eduplay_all_exam_submissions'
      ];
      globalListKeys.forEach((gk) => {
        const raw = localStorage.getItem(gk);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              const cleaned = filterSubmissionArrayByCodeAndTarget(parsed, false);
              localStorage.setItem(gk, JSON.stringify(cleaned));
            }
          } catch {}
        }
      });

      // Dọn eduplay_exam_subs_{docId} & eduplay_exam_draft_{code}_{docId}
      candDocIds.forEach((docId) => {
        const examSubKey = `eduplay_exam_subs_${docId}`;
        const rawExamSubs = localStorage.getItem(examSubKey);
        if (rawExamSubs) {
          try {
            const parsed = JSON.parse(rawExamSubs);
            if (Array.isArray(parsed)) {
              const cleaned = parsed.filter(
                (s: any) => !isSubmissionArrayItemMatched(s, codeSet, exactRawSubIds)
              );
              localStorage.setItem(examSubKey, JSON.stringify(cleaned));
            }
          } catch {}
        }

        codeSet.forEach((c) => {
          localStorage.removeItem(`eduplay_exam_draft_${c}_${docId}`);
          localStorage.removeItem(`eduplay_exam_draft_${c.toLowerCase()}_${docId}`);
        });
      });

      // Cập nhật cache `eduplay_cached_assignments` để tránh khôi phục dữ liệu cũ
      try {
        const cachedAssignments = getLocalCachedAssignments();
        let cacheChanged = false;
        const updatedCache = cachedAssignments.map((as) => {
          if (!as || !targetLowerSet.has(String(as.id || '').toLowerCase())) return as;
          const origSubs = Array.isArray(as.submissions) ? as.submissions : [];
          const filteredSubs = origSubs.filter(
            (s: any) => !isSubmissionArrayItemMatched(s, codeSet, exactRawSubIds)
          );
          const origIds = Array.isArray(as.submittedIds) ? as.submittedIds : [];
          const filteredIds = origIds.filter((idVal: any) => !codeSet.has(normalizeStudentCode(String(idVal || ''))));
          if (filteredSubs.length !== origSubs.length || filteredIds.length !== origIds.length) {
            cacheChanged = true;
            return {
              ...as,
              submissions: filteredSubs,
              submittedIds: filteredIds,
              submittedCount: filteredSubs.length,
              completedCount: filteredSubs.length
            };
          }
          return as;
        });
        if (cacheChanged) {
          saveAssignmentsToLocalStorage(updatedCache);
        }
      } catch {}
    } catch (lsErr) {
      console.warn('Lỗi dọn LocalStorage khi xóa bài tập:', lsErr);
    }
  }

  // 3. Xóa Memory cache & IndexedDB cache của module theo dõi nộp bài & Học bạ số
  for (const docId of candDocIds) {
    try {
      clearMemoryTrackingData(docId);
      await clearIndexedDBTrackingData(docId);
    } catch {}
  }

  try {
    invalidateAllSubmissionsCache();
  } catch {}

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('eduplay_student_submissions_updated'));
    window.dispatchEvent(new Event('eduplay_exam_submissions_updated'));
    window.dispatchEvent(new Event('eduplay_assignments_updated'));
    window.dispatchEvent(new Event('storage'));
    window.dispatchEvent(
      new CustomEvent('eduplay_submission_reset', {
        detail: {
          studentCode: normCode,
          assignmentId,
          candDocIds
        }
      })
    );
  }

  return { success: true, deletedCount };
}

