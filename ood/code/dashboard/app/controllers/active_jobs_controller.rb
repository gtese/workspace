# The controller for activejobs pages /dashboard/activejobs
require 'open3'
require 'etc'
require 'json'

class ActiveJobsController < ApplicationController
  include ActiveJobsHelper
  include ActionController::Live

  JOB_HELPER = '/usr/local/sbin/ood-jobctl'

  def index
    @jobfilter = get_filter
    @jobcluster = get_cluster

    respond_to do |format|
      format.html # index.html.erb
      format.json {
        ActiveJobs::JobsJsonRequestHandler.new(
          filter_id: @jobfilter,
          cluster_id: params[:jobcluster],
          controller: self,
          params: params,
          response: response
        ).render
      }
    end
  end

  def json
    respond_to do |format|
      format.html { # show.html.erb
        raise ActionController::RoutingError.new('Not Found')
      }
      format.json {
        #Only allow the configured servers to respond
        if cluster = OODClusters[params[:cluster].to_s.to_sym]
          render '/active_jobs/extended_data', :locals => {:jobstatusdata => get_job(params[:pbsid], cluster) }
        else
          msg = "Request did not specify an available cluster. "
          msg += "Available clusters are: #{OODClusters.map(&:id).join(',')} "
          msg += "But specified cluster is: #{params[:cluster]}"
          render :json => { name: params[:pbsid], error: msg }
        end
      }
    end
  end

  # Stop (cancel) a running or queued job.
  # The root helper enforces owner/admin permissions.
  def stop_job
    job_action('stop', 'Successfully stopped ', 'Failed to stop ')
  end

  # Remove a job from this user's Active Jobs list.
  # Owner or dashboard admin only; this only hides the record in the UI.
  def delete_job
    cluster = OODClusters[params[:cluster].to_s.to_sym]
    job_id = params[:pbsid].to_s.gsub(/_/, '.')

    if params[:pbsid].blank? || cluster.nil?
      return redirect_to(activejobs_path, alert: 'Failed to remove job: missing job id or cluster.')
    end

    begin
      info = cluster.job_adapter.info(job_id)
      unless can_manage_owner?(info.job_owner)
        return redirect_to(activejobs_path, alert: "Failed to remove #{job_id}: permission denied.")
      end
      hide_job(job_id)
      redirect_to activejobs_path, notice: "Removed #{job_id} from the job list."
    rescue => e
      redirect_to activejobs_path, alert: "Failed to remove #{job_id}: #{e.message}"
    end
  end

  private

  def can_manage_owner?(owner)
    admin_user? || owner.to_s == current_username
  end

  def current_username
    ENV['USER'] || Etc.getpwuid(Process.uid).name
  end

  def admin_user?
    groups = Process.groups.map { |gid| (Etc.getgrgid(gid).name rescue nil) }.compact
    (groups & %w[group_roots group_support]).any?
  end

  def hidden_jobs_file
    File.join(Dir.home, '.ood_activejobs_hidden.json')
  end

  def hidden_jobs
    return [] unless File.file?(hidden_jobs_file)
    JSON.parse(File.read(hidden_jobs_file))
  rescue StandardError
    []
  end

  def hide_job(job_id)
    ids = (hidden_jobs + [job_id.to_s]).uniq
    File.write(hidden_jobs_file, JSON.pretty_generate(ids))
  end


  def job_action(action, success_prefix, failure_prefix)
    cluster = OODClusters[params[:cluster].to_s.to_sym]
    job_id = params[:pbsid].to_s.gsub(/_/, '.')

    if params[:pbsid].blank? || cluster.nil?
      return redirect_to(activejobs_path, alert: "#{failure_prefix}job: missing job id or cluster.")
    end

    _out, err, status = Open3.capture3('sudo', '-n', JOB_HELPER, action, job_id.to_s)
    if status.success?
      sleep(1.0)
      redirect_to activejobs_path, notice: "#{success_prefix}#{job_id}"
    else
      msg = err.to_s.strip
      msg = "permission denied or operation rejected" if msg.empty?
      redirect_to activejobs_path, alert: "#{failure_prefix}#{job_id}: #{msg}"
    end
  end



  # Get the extended data for a particular job.
  #
  # @param [String] jobid The id of the job
  # @param [OodCore::Cluster] cluster The selected cluster instance from OODClusters
  #
  # @return [Jobstatusdata] The job data as a Jobstatusdata object
  def get_job(jobid, cluster)
    begin
      data = cluster.job_adapter.info(jobid)

      raise OodCore::JobAdapterError if data.native.nil?
      ActiveJobs::Jobstatusdata.new(data, cluster, true)

    rescue OodCore::JobAdapterError
      OpenStruct.new(name: jobid, error: "No job details because job has already left the queue." , status: status_label("completed") )
    rescue => e
      Rails.logger.info("#{e}:#{e.message}")
      Rails.logger.info(e.backtrace.join("\n"))
      OpenStruct.new(name: jobid, error: "No job details available.\n" + e.backtrace.to_s, status: status_label("") )
    end
  end

  # Returns the filter id from the parameter if it is valid
  #
  # @return [String, nil] the filter id if valid
  def get_filter
    if params[:jobfilter] && filters.any? { |f| f.filter_id == params[:jobfilter] }
      params[:jobfilter]
    end
  end

  # Returns the cluster id from the parameter if it is valid
  #
  # @return [String, nil] the cluster id if valid
  def get_cluster
    if params[:jobcluster] && (OODClusters[params[:jobcluster]] || params[:jobcluster] == 'all')
      params[:jobcluster]
    end
  end

end
