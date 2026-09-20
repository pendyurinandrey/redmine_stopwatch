class ConvertStopwatchColumnsToUtf8 < ActiveRecord::Migration[7.2]
  def up
    return unless mysql?

    change_column :stopwatch_segments, :comments, :text,
                  charset: 'utf8', collation: 'utf8_general_ci'
    change_column :stopwatch_timers, :state, :string,
                  null: false, default: 'stopped',
                  charset: 'utf8', collation: 'utf8_general_ci'
  end

  def down
    return unless mysql?

    change_column :stopwatch_segments, :comments, :text
    change_column :stopwatch_timers, :state, :string,
                  null: false, default: 'stopped'
  end

  private

  # charset/collation options only exist on MySQL/MariaDB
  def mysql?
    connection.adapter_name.downcase.match?(/mysql|trilogy|maria/)
  end
end
