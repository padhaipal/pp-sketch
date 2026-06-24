import { DataSource } from 'typeorm';
import { UserEntity } from '../../users/user.entity';
import { LetterEntity } from '../../literacy/letters/letter.entity';
import { MediaMetaDataEntity } from '../../media-meta-data/media-meta-data.entity';
import { ScoreEntity } from '../../literacy/score/score.entity';
import { LiteracyLessonStateEntity } from '../../literacy/literacy-lesson/literacy-lesson-state.entity';
import { QuizResponseEntity } from '../dashboard/quiz-response.entity';
import { MailingListEntryEntity } from '../dashboard/mailing-list-entry.entity';
import { QuizShareTokenEntity } from '../dashboard/quiz-share-token.entity';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [
    UserEntity,
    LetterEntity,
    MediaMetaDataEntity,
    ScoreEntity,
    LiteracyLessonStateEntity,
    QuizResponseEntity,
    MailingListEntryEntity,
    QuizShareTokenEntity,
  ],
  migrations: ['dist/interfaces/database/migrations/*.js'],
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === 'true',
  // node-postgres pool size PER REPLICA. With N pp-sketch replicas the total
  // demand is N*max against Postgres max_connections (currently 350): keep
  // (replicas * max) well under it, leaving headroom for the dashboard,
  // migrations, admin, and deploy-time overlap.
  extra: { max: 20 },
});
