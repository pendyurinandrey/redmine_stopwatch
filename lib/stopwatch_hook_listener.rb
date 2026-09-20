# frozen_string_literal: true

class StopwatchHookListener < Redmine::Hook::ViewListener
  # Keys of the strings the JavaScript widget needs (translated server-side)
  I18N_KEYS = %i[
    button_stopwatch_start button_stopwatch_start_here button_stopwatch_stop
    button_stopwatch_recent label_stopwatch_recent_title label_stopwatch_recent_empty
    label_stopwatch_recent_active label_stopwatch_recent_today label_stopwatch_recent_loading
    label_stopwatch_unsaved_segments notice_stopwatch_logged notice_stopwatch_discarded
    notice_stopwatch_kept error_stopwatch_generic
  ].freeze

  # Inject plugin CSS and JS into <head>
  def view_layouts_base_html_head(context)
    return '' unless User.current.allowed_to?(:use_stopwatch, nil, global: true)

    context[:hook_caller].stylesheet_link_tag('stopwatch', plugin: 'redmine_stopwatch') +
      context[:hook_caller].javascript_include_tag('stopwatch', plugin: 'redmine_stopwatch')
  end

  # Inject the timer widget (the JS moves it to <body> and renders the bar)
  def view_layouts_base_body_top(context)
    return '' unless User.current.allowed_to?(:use_stopwatch, nil, global: true)

    timer = StopwatchTimer.find_or_initialize_by(user_id: User.current.id)
    timer.state               ||= 'stopped'
    timer.accumulated_seconds ||= 0

    view          = context[:hook_caller]
    page_context  = detect_page_context(view, context[:request].path)
    timer_context = detect_timer_context(view, timer)
    pending_count = StopwatchSegment.where(user_id: User.current.id).count
    i18n          = I18N_KEYS.each_with_object({}) { |key, h| h[key] = I18n.t(key) }

    view.render(
      partial: 'stopwatch/widget',
      locals:  {
        timer:         timer,
        page_context:  page_context,
        timer_context: timer_context,
        pending_count: pending_count,
        i18n:          i18n
      }
    )
  end

  private

  # The issue shown on the current page (if any). Only issues the user can
  # both see and log time on can start the timer.
  def detect_page_context(view, path)
    result = { id: nil, subject: nil, url: nil, can_track: false }
    return result unless (m = path.match(%r{/issues/(\d+)(?:[/.]|\z)}))

    issue = Issue.visible.find_by(id: m[1])
    if issue
      result[:id]        = issue.id.to_s
      result[:subject]   = issue.subject
      result[:url]       = view.issue_path(issue)
      result[:can_track] = User.current.allowed_to?(:log_time, issue.project)
    end
    result
  end

  # The issue the timer is currently running on (if any)
  def detect_timer_context(view, timer)
    result = { id: nil, subject: nil, url: nil }
    return result unless timer.issue_id.present?

    issue = Issue.visible.find_by(id: timer.issue_id)
    if issue
      result[:id]      = issue.id.to_s
      result[:subject] = issue.subject
      result[:url]     = view.issue_path(issue)
    else
      result[:id] = timer.issue_id.to_s
    end
    result
  end
end
