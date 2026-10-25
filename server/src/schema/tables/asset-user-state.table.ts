import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { AssetColorLabel } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

// per-user asset state. Favorite and rating are the source of truth only for assets the user does not own
// (asset.isFavorite and asset_exif.rating stay authoritative for owned assets); owner rows exist for the favorite
// mirror and for the color label, which has no legacy column.
@Check({ name: 'asset_user_state_rating_chk', expression: `"rating" BETWEEN 1 AND 5` })
@Check({
  name: 'asset_user_state_colorLabel_chk',
  expression: `"colorLabel" IN ('red','yellow','green','blue','purple')`,
})
@Table('asset_user_state')
export class AssetUserStateTable {
  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: false })
  userId!: string;

  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: true })
  assetId!: string;

  @Column({ type: 'boolean', default: false })
  isFavorite!: Generated<boolean>;

  @Column({ type: 'smallint', nullable: true })
  rating!: number | null;

  @Column({ type: 'text', nullable: true })
  colorLabel!: AssetColorLabel | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
