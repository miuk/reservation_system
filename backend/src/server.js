import { createApp, createEnv } from './app.js';

const env = createEnv();
const app = createApp({ env });

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

app.listen(env.port, () => {
  console.log(`reservation backend listening on ${env.port}`);
  console.log('backend runtime config:', {
    firebaseProjectId: env.projectId,
    firestoreProjectId: env.firestoreProjectId,
    firestoreDatabaseId: env.databaseId,
    resourceName: env.resourceName,
    reservationMonthsAhead: env.reservationMonthsAhead,
    maxSlotsPerRequest: env.maxSlotsPerRequest
  });
});
