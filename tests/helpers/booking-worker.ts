import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../src/db/database.ts';
import { createMeeting, updateMeeting } from '../../src/domain/meetings.ts';
import { toAppError } from '../../src/domain/errors.ts';

const db = openDatabase(workerData.path);
parentPort!.once('message', () => {
  try {
    const meeting = workerData.operation === 'reschedule'
      ? updateMeeting(db, workerData.meetingId, workerData.body)
      : createMeeting(db, workerData.body);
    parentPort!.postMessage({ status: workerData.operation === 'reschedule' ? 200 : 201, meeting });
  } catch (error) {
    const failure = toAppError(error);
    parentPort!.postMessage({ status: failure.status, code: failure.code });
  } finally {
    db.close();
    parentPort!.close();
  }
});
parentPort!.postMessage('ready');
