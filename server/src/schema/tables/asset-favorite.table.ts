import { CreateDateColumn, ForeignKeyColumn, type Generated, Table, Timestamp } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

// favorites a user set on assets they do not own; owned assets keep using asset.isFavorite
@Table('asset_favorite')
export class AssetFavoriteTable {
  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: false })
  userId!: string;

  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true, index: true })
  assetId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
