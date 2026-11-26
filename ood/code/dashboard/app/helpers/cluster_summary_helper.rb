# Cluster summary for the OOD dashboard home page.
# Read-only Slurm CLI queries; no cluster state is changed.
require 'open3'

module ClusterSummaryHelper
  def cluster_summary
    return @cluster_summary if defined?(@cluster_summary) && @cluster_summary

    nodes = []
    out, status = Open3.capture2('sinfo', '-a', '-N', '-h', '-o', '%N|%P|%t|%c|%m|%e|%C')
    if status.success?
      out.each_line do |line|
        name, partitions, state, cpus, memory_mb, free_memory_mb, cpu_state = line.strip.split('|')
        next if name.blank?

        _alloc, idle, _other, _total = cpu_state.to_s.split('/').map(&:to_i)
        node_partitions = partitions.to_s.split(',').map { |p| p.sub(/\*\z/, '') }
        nodes << {
          name: name.sub(/\*\z/, ''),
          partitions: node_partitions,
          restricted: (node_partitions & restricted_partition_names).any?,
          state: state.to_s,
          cpus: cpus.to_i,
          memory_mb: memory_mb.to_i,
          available_memory_mb: free_memory_mb.to_i,
          available_cpus: idle.to_i,
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

    # Historical jobs per node from Slurm accounting (cached for 5 minutes).
    history_nodes, history_total = historical_node_counts
    nodes.each { |n| n[:historical_jobs] = history_nodes.fetch(n[:name], 0) }

    @cluster_summary = {
      nodes: nodes,
      node_count: nodes.size,
      cpu_count: nodes.sum { |n| n[:cpus] },
      memory_mb: nodes.sum { |n| n[:memory_mb] },
      available_cpus: nodes.sum { |n| n[:available_cpus] },
      available_memory_mb: nodes.sum { |n| n[:available_memory_mb] },
      users: jobs.map { |j| j[:user] }.uniq.size,
      job_count: jobs.size,
      running_jobs: jobs.count { |j| j[:state] == 'RUNNING' },
      pending_jobs: jobs.count { |j| j[:state] == 'PENDING' },
      idle_nodes: nodes.count { |n| n[:state].downcase.include?('idle') },
      allocated_nodes: nodes.count { |n| n[:state].downcase.match?(/alloc|mix/) },
      historical_job_count: history_total,
      generated_at: Time.now
    }
  rescue StandardError => e
    Rails.logger.warn("cluster_summary failed: #{e.class}: #{e.message}")
    @cluster_summary = {
      nodes: [], node_count: 0, cpu_count: 0, memory_mb: 0, available_cpus: 0,
      available_memory_mb: 0, users: 0, job_count: 0, running_jobs: 0, pending_jobs: 0,
      idle_nodes: 0, allocated_nodes: 0, historical_job_count: 0,
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
      # fallback: only partitions visible to this user; restricted ones may be hidden
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

  private

  def historical_node_counts
    Rails.cache.fetch('ood_cluster_historical_node_counts_v1', expires_in: 5.minutes) do
      counts = Hash.new(0)
      total = 0
      out, status = Open3.capture2('sacct', '-a', '-X', '-n', '-P', '-o', 'NodeList')
      if status.success?
        out.each_line do |line|
          list = line.strip
          next if list.blank?

          total += 1
          expand_node_list(list).each { |n| counts[n] += 1 }
        end
      end
      [counts, total]
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
