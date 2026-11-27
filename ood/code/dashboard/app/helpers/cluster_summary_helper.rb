# Cluster summary for the OOD dashboard home page.
# Read-only Slurm CLI queries; no cluster state is changed.
require 'open3'
require 'time'

module ClusterSummaryHelper
  def cluster_summary
    return @cluster_summary if defined?(@cluster_summary) && @cluster_summary

    nodes = []
    out, status = Open3.capture2('sinfo', '-a', '-N', '-h', '-o', '%N|%P|%t|%c|%m|%e|%C|%O')
    if status.success?
      out.each_line do |line|
        name, partitions, state, cpus, memory_mb, free_memory_mb, cpu_state, load = line.strip.split('|')
        next if name.blank?

        _alloc, idle, _other, _total = cpu_state.to_s.split('/').map(&:to_i)
        node_partitions = partitions.to_s.split(',').map { |p| p.sub(/\*\z/, '') }
        total_cpus = cpus.to_i
        total_mem = memory_mb.to_i
        avail_cpus = idle.to_i
        avail_mem = free_memory_mb.to_i
        nodes << {
          name: name.sub(/\*\z/, ''),
          partitions: node_partitions,
          restricted: (node_partitions & restricted_partition_names).any?,
          state: state.to_s,
          cpus: total_cpus,
          memory_mb: total_mem,
          available_memory_mb: avail_mem,
          available_cpus: avail_cpus,
          load: load.to_f,
          cpu_used_percent: total_cpus > 0 ? ((total_cpus - avail_cpus).to_f / total_cpus * 100.0) : 0.0,
          memory_used_percent: total_mem > 0 ? ((total_mem - avail_mem).to_f / total_mem * 100.0) : 0.0,
          current_users: 0,
          current_jobs: 0,
          historical_jobs: 0
        }
      end
    end
    nodes = nodes.uniq { |n| n[:name] }

    # Current queue state (all users).
    jobs = []
    jout, jstatus = Open3.capture2('squeue', '-a', '-h', '-P', '-o', '%T|%u|%N')
    if jstatus.success?
      jout.each_line do |line|
        state, user, node_list = line.strip.split('|')
        next if user.blank?

        jobs << { state: state.to_s, user: user.to_s, nodes: expand_node_list(node_list) }
      end
    end

    # Current users/jobs per node (running jobs only).
    by_node = nodes.each_with_object({}) { |n, h| h[n[:name]] = n }
    jobs.select { |j| j[:state] == 'RUNNING' }.each do |job|
      job[:nodes].each do |node_name|
        node = by_node[node_name]
        next unless node

        node[:current_jobs] += 1
        node[:users] ||= []
        node[:users] << job[:user]
      end
    end
    nodes.each do |n|
      n[:current_users] = (n.delete(:users) || []).uniq.size
    end

    # Historical jobs per node + period/top-user stats from Slurm accounting (cache 5 min).
    history = historical_stats
    nodes.each { |n| n[:historical_jobs] = history[:node_counts].fetch(n[:name], 0) }

    total_cpus = nodes.sum { |n| n[:cpus] }
    total_mem = nodes.sum { |n| n[:memory_mb] }
    avail_cpus = nodes.sum { |n| n[:available_cpus] }
    avail_mem = nodes.sum { |n| n[:available_memory_mb] }
    running_by_user = jobs.select { |j| j[:state] == 'RUNNING' }.group_by { |j| j[:user] }.transform_values(&:size)

    top_users = history[:user_counts].sort_by { |_u, c| -c }.first(3).map do |user, count|
      { user: user, historical: count, running: running_by_user.fetch(user, 0) }
    end

    @cluster_summary = {
      nodes: nodes,
      node_count: nodes.size,
      cpu_count: total_cpus,
      memory_mb: total_mem,
      available_cpus: avail_cpus,
      available_memory_mb: avail_mem,
      cpu_used_percent: total_cpus > 0 ? ((total_cpus - avail_cpus).to_f / total_cpus * 100.0) : 0.0,
      memory_used_percent: total_mem > 0 ? ((total_mem - avail_mem).to_f / total_mem * 100.0) : 0.0,
      average_load: nodes.empty? ? 0.0 : (nodes.sum { |n| n[:load] }.to_f / nodes.size),
      users: jobs.map { |j| j[:user] }.uniq.size,
      job_count: jobs.size,
      running_jobs: jobs.count { |j| j[:state] == 'RUNNING' },
      pending_jobs: jobs.count { |j| j[:state] == 'PENDING' },
      idle_nodes: nodes.count { |n| n[:state].downcase.include?('idle') },
      allocated_nodes: nodes.count { |n| n[:state].downcase.match?(/alloc|mix/) },
      historical_job_count: history[:total],
      today_jobs: history[:today],
      week_jobs: history[:week],
      month_jobs: history[:month],
      top_users: top_users,
      generated_at: Time.now
    }
  rescue StandardError => e
    Rails.logger.warn("cluster_summary failed: #{e.class}: #{e.message}")
    @cluster_summary = {
      nodes: [], node_count: 0, cpu_count: 0, memory_mb: 0, available_cpus: 0,
      available_memory_mb: 0, cpu_used_percent: 0.0, memory_used_percent: 0.0,
      average_load: 0.0, users: 0, job_count: 0, running_jobs: 0, pending_jobs: 0,
      idle_nodes: 0, allocated_nodes: 0, historical_job_count: 0,
      today_jobs: 0, week_jobs: 0, month_jobs: 0, top_users: [],
      generated_at: Time.now, error: e.message
    }
  end

  def cluster_memory_text(memory_mb)
    return '0G' if memory_mb.to_i <= 0

    gb = memory_mb.to_f / 1024.0
    text = if gb >= 100
             format('%.0fG', gb)
           else
             format('%.1fG', gb)
           end
    text.sub(/\.0G\z/, 'G')
  end

  def cluster_node_state_class(state, restricted = false)
    s = state.to_s.downcase
    return 'badge-warning' if restricted
    return 'badge-danger' if s.match?(/down|drain|fail|unk|alloc/)
    return 'badge-primary' if s.include?('mix')
    return 'badge-success' if s.include?('idle')

    'badge-secondary'
  end

  def cluster_node_state_text(state)
    case state.to_s.downcase
    when /idle/ then 'Available: no CPUs are currently allocated.'
    when /mix/ then 'Partially allocated: some CPUs are in use, some are available.'
    when /alloc/ then 'Fully allocated: all CPUs are in use; no free CPUs.'
    when /drain/ then 'Draining: no new jobs are accepted; existing jobs may still run.'
    when /down|fail/ then 'Unavailable: the node is down or failed.'
    when /comp/ then 'Completing: finishing current jobs.'
    when /unk/ then 'Unknown: the node state is not known yet.'
    else state.to_s
    end
  end

  # Partitions that are not open to every user (AllowGroups/AllowAccounts/AllowQos != ALL).
  def restricted_partition_names
    return @restricted_partition_names if defined?(@restricted_partition_names) && @restricted_partition_names

    names = []
    begin
      File.readlines('/etc/slurm/slurm.conf').each do |line|
        next unless line.start_with?('PartitionName=')

        name = line[/PartitionName=([^\s]+)/, 1]
        next if name.blank?

        restrictions = %w[AllowGroups AllowAccounts AllowQos].map { |key| line[/#{key}=([^\s]+)/, 1] }.compact
        names << name if restrictions.any? { |value| value != 'ALL' }
      end
    rescue StandardError
      out, status = Open3.capture2('scontrol', 'show', 'partition', '-o')
      if status.success?
        out.each_line do |line|
          name = line[/PartitionName=([^\s]+)/, 1]
          next if name.blank?

          restrictions = %w[AllowGroups AllowAccounts AllowQos].map { |key| line[/#{key}=([^\s]+)/, 1] }.compact
          names << name if restrictions.any? { |value| value != 'ALL' }
        end
      end
    end
    @restricted_partition_names = names.uniq
  end

  private

  def historical_stats
    Rails.cache.fetch('ood_cluster_history_stats_v2', expires_in: 5.minutes) do
      now = Time.now
      today_start = Time.local(now.year, now.month, now.day)
      monday = now.to_date - ((now.wday - 1) % 7)
      week_start = Time.local(monday.year, monday.month, monday.day)
      month_start = Time.local(now.year, now.month, 1)

      counts = Hash.new(0)
      user_counts = Hash.new(0)
      total = today = week = month = 0

      out, status = Open3.capture2('sacct', '-a', '-X', '-n', '-P', '-o', 'JobID,User,Submit,NodeList')
      if status.success?
        out.each_line do |line|
          _id, user, submit, list = line.strip.split('|')
          next if user.blank?

          total += 1
          user_counts[user] += 1
          begin
            submitted = Time.parse(submit)
            today += 1 if submitted >= today_start
            week += 1 if submitted >= week_start
            month += 1 if submitted >= month_start
          rescue ArgumentError, TypeError
            # ignore rows without a parseable submit time
          end
          expand_node_list(list).each { |n| counts[n] += 1 }
        end
      end

      { node_counts: counts, user_counts: user_counts, total: total,
        today: today, week: week, month: month }
    end
  end

  def expand_node_list(list)
    list.to_s.split(',').flat_map do |part|
      part = part.strip
      next [] if part.empty?

      if part =~ /\A(.*?)\[([^\]]+)\]\z/
        prefix = Regexp.last_match(1)
        ranges = Regexp.last_match(2)
        ranges.split(',').flat_map do |r|
          if r =~ /\A(\d+)-(\d+)\z/
            (Regexp.last_match(1).to_i..Regexp.last_match(2).to_i).map { |i| "#{prefix}#{i}" }
          else
            ["#{prefix}#{r}"]
          end
        end
      else
        [part]
      end
    end
  end
end
