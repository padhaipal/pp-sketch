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
});
