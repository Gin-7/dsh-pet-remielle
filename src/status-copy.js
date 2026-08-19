/**
 * Remielle-flavored status copy. Same group keys as dsh-dafeiyu's
 * status-copy.js so the reducer ports unchanged, but the phrasing is the
 * 蕾米埃尔 persona (a brisk, slightly smug hunter-goddess tone).
 */

const COPY = Object.freeze({
  idle: [
    '待机中哦，有任务记得叫我呀',
    '现在没有任务，我先眯一会儿',
    '蕾米埃尔待命中~',
  ],
  preparing: [
    '新任务来了，先梳理一下呢',
    '让我看看这次要做什么呀',
    '正在整理任务清单呢',
  ],
  thinking: [
    '正在认真思考下一步呢',
    '让我想想最优解是什么',
    '思路整理中，稍等片刻~',
  ],
  streaming: [
    '正在输出回答哦',
    '内容正在写出来呢',
    '这句话马上就好~',
  ],
  searching: [
    '正在帮你翻找相关内容呢',
    '正在项目里搜索呢',
    '正在查看相关文件哦',
  ],
  editing: [
    '正在修改这部分内容呢',
    '改动正在写入哦',
    '正在认真调整实现呢',
  ],
  testing: [
    '正在检查结果呢',
    '正在跑测试确认一下哦',
    '正在验证改动有没有问题呢',
  ],
  commanding: [
    '正在执行命令呢',
    '正在让项目跑起来哦',
    '正在看命令执行得怎么样呢',
  ],
  working: [
    '正在继续处理任务呢',
    '这一步正在进行中哦',
    '蕾米埃尔还在认真干活呢',
  ],
  result: [
    '正在整理刚才的结果呢',
    '这一步处理好了，继续哦',
    '正在确认下一步怎么做呢',
  ],
  waiting: [
    '需要你确认一下哦',
    '这里要等你看一眼呢',
    '轮到你来决定啦',
  ],
  success: [
    '这次任务搞定啦~',
    '这一轮顺利完成哦',
    '任务完成咯，干得漂亮',
  ],
  toolError: [
    '这一步好像没跑通呢',
    '刚才的操作遇到点问题哦',
    '这里卡了一下，我在看着呢',
  ],
  error: [
    '任务好像遇到问题了哦',
    '这里需要回来看看呢',
    '这次没有顺利跑完呢',
  ],
  stopped: [
    '任务已经停下来啦',
    '这次任务先停在这里哦',
  ],
  limit: [
    '内容有点多，到上限啦',
    '这次输出已经到上限咯',
  ],
})

function seedNumber(seed) {
  const number = Number(seed)
  if (Number.isFinite(number)) return Math.abs(Math.trunc(number))
  return [...String(seed ?? '')].reduce((total, character) => total + character.codePointAt(0), 0)
}

export function statusCopy(group, seed = 0) {
  const variants = COPY[group] ?? COPY.working
  return variants[seedNumber(seed) % variants.length]
}

export function activityCopy(activity, seed = 0) {
  return statusCopy({
    searching: 'searching',
    editing: 'editing',
    testing: 'testing',
    commanding: 'commanding',
  }[activity] ?? 'working', seed)
}

export function activityStage(activity) {
  return {
    searching: '查找阶段',
    editing: '实现阶段',
    testing: '验证阶段',
    commanding: '执行阶段',
  }[activity] ?? '处理阶段'
}

export function taskCopy(task) {
  const value = String(task ?? '').trim().replace(/[。！？.!?]+$/u, '')
  if (!value) return statusCopy('working')
  if (/^(正在|继续)/u.test(value)) {
    return `${value}呢`
  }
  if (/^(准备|检查|验证|修改|修复|测试|构建|整理|分析|梳理|查找|搜索|读取|实现)/u.test(value)) {
    return `正在${value}呢`
  }
  return `正在处理「${value}」呢`
}

export { COPY as statusCopyLibrary }
