-- ============================================================================
-- /etc/slurm/job_submit.lua
-- 2026-11-09  eda151-155 大内存节点内存超卖防护
-- 策略: 提交到新节点分区(eda15x / node151~node155)的作业必须显式指定内存
--       (--mem 或 --mem-per-cpu)，否则拒绝提交，避免"未记账作业"多用户并发
--       把 2TB 物理内存耗尽导致系统级 OOM。
-- 说明: 老分区(node131/132/133/eda)暂不强制，避免影响现有用户习惯；
--       如需全集群强制，把 enforced 表改成 is_new_partition() 恒真即可。
-- ============================================================================
local enforced = {
    ["eda15x"] = true,
    ["node151"] = true,
    ["node152"] = true,
    ["node153"] = true,
    ["node154"] = true,
    ["node155"] = true,
}

-- Slurm 内存字段编码（Lua 为 double，大数会失真）:
--   未指定          -> NO_VAL64 = 0xFFFFFFFFFFFFFFFF  ≈ 1.8446744e19
--   --mem=<MB>      -> 正常整数（如 4096）
--   --mem-per-cpu   -> 0x8000000000000000 | MB/cpu ≈ 9.2233720e18（低位数被 double 舍入）
local function mem_unset(m)
    if m == nil then return true end
    if type(m) ~= "number" then return true end
    if m == 0 then return true end
    if m >= 1.5e19 then return true end   -- NO_VAL64
    return false                          -- 普通 --mem 或 --mem-per-cpu 均视为已指定
end

function slurm_job_submit(job_desc, part_list, submit_uid)
    local part = job_desc.partition
    -- 未指定 --partition 时，Slurm 会使用默认分区（当前集群默认为 eda15x），
    -- 此时 job_desc.partition 为 nil，必须按默认分区同样强制内存声明。
    local DEFAULT_PARTITION = "eda15x"
    if part == nil then part = DEFAULT_PARTITION end
    if enforced[tostring(part)] then
        if mem_unset(job_desc.pn_min_memory) then
            local msg = string.format(
                "提交被拒绝：目标分区 %s 的节点(eda151-155, 单机 1900G 内存)要求显式指定内存。\n" ..
                "请在作业脚本中加入: #SBATCH --mem=<大小>   例如: --mem=32G\n" ..
                "或命令行加: --mem=32G / --mem-per-cpu=4G", tostring(part))
            slurm.log_user(msg)
            slurm.log_info("job_submit: REJECT job without memory spec on partition %s (uid=%u)", tostring(part), submit_uid)
            return slurm.ERROR
        end
    end
    return slurm.SUCCESS
end

function slurm_job_modify(job_desc, job_rec, part_list, modify_uid)
    return slurm.SUCCESS
end
