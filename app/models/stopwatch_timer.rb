# frozen_string_literal: true

class StopwatchTimer < ApplicationRecord
  belongs_to :user
  belongs_to :project,  optional: true
  belongs_to :issue,    optional: true
  belongs_to :activity, class_name: 'TimeEntryActivity', optional: true

  STATES = %w[stopped running paused].freeze

  # LOCAL CHANGE: segments shorter than this are discarded instead of being
  # written to Redmine (protects against accidental taps / instant switches).
  MIN_SEGMENT_SECONDS = 60

  validates :state, inclusion: { in: STATES }

  # Outcome of the most recent stop!/snap! call, exposed to the controller so
  # the UI can tell the user what happened. Hash or nil:
  #   { status: 'logged',    issue_id:, hours:, entry_id: }
  #   { status: 'discarded', issue_id:, seconds: }
  #   { status: 'kept',      issue_id:, reason: }   (auto-logging failed; the
  #                                                   segment stays in the list)
  attr_reader :last_result

  # Total elapsed seconds, including live time if currently running
  def elapsed_seconds
    base = accumulated_seconds || 0
    if state == 'running' && started_at.present?
      base + (Time.now.utc - started_at).to_i
    else
      base
    end
  end

  # Elapsed time formatted as "H:MM"
  def elapsed_display
    secs = elapsed_seconds
    total_minutes = secs / 60
    hours   = total_minutes / 60
    minutes = total_minutes % 60
    "#{hours}:#{format('%02d', minutes)}"
  end

  # Elapsed time as fractional hours (for TimeEntry.hours)
  def elapsed_hours
    elapsed_seconds / 3600.0
  end

  # --- State transitions ---

  def start!(issue_id: nil, project_id: nil)
    @last_result             = nil
    self.state               = 'running'
    self.started_at          = Time.now.utc
    self.started_on          = local_today
    self.accumulated_seconds = 0
    self.issue_id            = issue_id
    self.project_id          = project_id
    self.comments            = nil
    self.activity_id         = nil
    save!
  end

  def pause!
    return unless state == 'running'

    self.accumulated_seconds = elapsed_seconds
    self.started_at          = nil
    self.state               = 'paused'
    save!
  end

  def resume!
    return unless state == 'paused'

    self.started_at = Time.now.utc
    self.state      = 'running'
    save!
  end

  # Saves the current segment, stops the timer and immediately turns the
  # segment into a Redmine time entry. Returns the segment (or nil).
  def stop!
    @last_result = nil
    segment = build_and_save_segment
    reset!
    auto_log_segment(segment)
    segment
  end

  # Saves the current segment, immediately turns it into a time entry and
  # continues running on the new issue with a fresh counter.
  # Note: if called while paused, also resumes the timer (design decision).
  def snap!(new_issue_id: nil, new_project_id: nil)
    @last_result = nil
    segment = build_and_save_segment
    self.accumulated_seconds = 0
    self.started_at          = Time.now.utc
    self.started_on          = local_today
    self.state               = 'running'
    self.issue_id            = new_issue_id
    self.project_id          = new_project_id
    self.comments            = nil
    self.activity_id         = nil
    save!
    auto_log_segment(segment)
    segment
  end

  # Saves a segment with custom seconds, adjusts timer accordingly.
  # Decrease (entered < elapsed): timer continues with remainder, keeps current state.
  # Increase/equal (entered >= elapsed): timer resets to 0 and continues running.
  # Note: comments/activity_id are intentionally NOT cleared — unlike snap!(), this method
  # is called from the Segments page to adjust hours within the same task context.
  def snap_with_hours!(entered_seconds)
    current = elapsed_seconds
    build_and_save_segment(entered_seconds)

    remainder = [current - entered_seconds, 0].max

    if remainder > 0
      self.accumulated_seconds = remainder
      self.started_at          = (state == 'running' ? Time.now.utc : nil)
    else
      self.accumulated_seconds = 0
      self.started_at          = Time.now.utc
      self.state               = 'running'
    end

    save!
  end

  private

  # The user's own "today" (respects the time zone set in My account) so that
  # entries made shortly after local midnight are not booked to yesterday.
  def local_today
    (user || User.find_by(id: user_id))&.today || Time.now.utc.to_date
  end

  def build_and_save_segment(seconds_override = nil)
    secs = seconds_override || elapsed_seconds

    if secs < MIN_SEGMENT_SECONDS
      @last_result = { status: 'discarded', issue_id: issue_id, seconds: secs } if issue_id.present?
      return nil
    end

    StopwatchSegment.create!(
      user_id:     user_id,
      project_id:  project_id,
      issue_id:    issue_id,
      activity_id: activity_id,
      seconds:     secs,
      spent_on:    started_on || local_today,
      comments:    comments.presence
    )
  end

  # Turns a freshly saved segment into a Redmine TimeEntry (default activity,
  # comment = issue subject). If anything goes wrong the segment simply stays
  # in the segments list, so no tracked time is ever lost.
  def auto_log_segment(segment)
    return unless segment&.persisted?

    unless segment.project_id.present?
      @last_result = { status: 'kept', issue_id: segment.issue_id, reason: 'no_project' }
      return
    end

    activity_id = segment.activity_id.presence ||
                  TimeEntryActivity.default_activity_id(segment.user, segment.project) ||
                  TimeEntryActivity.available_activities(segment.project).first&.id
    if activity_id.blank?
      @last_result = { status: 'kept', issue_id: segment.issue_id, reason: 'no_activity' }
      return
    end

    comments = segment.comments.presence ||
               segment.issue&.subject.presence ||
               segment.project&.name.to_s

    entry = segment.save_as_time_entry!(activity_id: activity_id, comments: comments)
    @last_result = { status: 'logged', issue_id: entry.issue_id, hours: entry.hours.to_f, entry_id: entry.id }
  rescue ActiveRecord::ActiveRecordError => e
    Rails.logger.warn("[stopwatch] auto-log failed, segment kept: #{e.message}")
    @last_result = { status: 'kept', issue_id: segment&.issue_id, reason: 'error' }
  end

  def reset!
    self.state               = 'stopped'
    self.started_at          = nil
    self.started_on          = nil
    self.accumulated_seconds = 0
    self.issue_id            = nil
    self.project_id          = nil
    self.comments            = nil
    self.activity_id         = nil
    save!
  end
end
