import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../src/db/database.ts';
import { createMeeting, updateMeeting } from '../../src/domain/meetings.ts';
import { createCall } from '../../src/domain/calls.ts';
import { toAppError } from '../../src/domain/errors.ts';

const db = openDatabase(workerData.path);
parentPort!.once('message', () => {
  try {
    const update = ['reschedule', 'cancel'].includes(workerData.operation);
    const result = workerData.operation === 'call' ? createCall(db, workerData.body)
      : update ? updateMeeting(db, workerData.meetingId, workerData.body)
        : createMeeting(db, workerData.body);
    parentPort!.postMessage({ status: update ? 200 : 201, result });
  } catch (error) {
    const failure = toAppError(error);
    parentPort!.postMessage({ status: failure.status, code: failure.code });
  } finally {
    db.close();
    parentPort!.close();
  }
});
parentPort!.postMessage('ready');
