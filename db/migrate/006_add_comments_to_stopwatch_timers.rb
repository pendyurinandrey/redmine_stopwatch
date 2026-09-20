class AddCommentsToStopwatchTimers < ActiveRecord::Migration[7.2]
  def change
    # charset/collation options only exist on MySQL/MariaDB
    options = connection.adapter_name.downcase.match?(/mysql|trilogy|maria/) ? { charset: 'utf8', collation: 'utf8_general_ci' } : {}
    add_column :stopwatch_timers, :comments, :text, **options
  end
end
