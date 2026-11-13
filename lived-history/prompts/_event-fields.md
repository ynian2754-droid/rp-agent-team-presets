【事件的字段】（集合 events；id、createdAt、updatedAt、active 由插件填，不用写）
- 必填：content（一两句客观陈述：谁对谁做了什么，结果如何；不写动机，不写评价）、storyTime（故事内时间）、people（涉及的人名数组）、source、perceivers、weight、shown。
- source 取：裁定、用户（用户角色自己的言行）、用户指定（合写打开时，用户替人物定的结果）、幕外、正文、正文越权、开卷、揭示、补充、找补（注明是哪一档授权的）、作者补充、作者修订、摘要、更正。
- perceivers 每人一条 {who, how, what}，who、how 必填。how 取 亲历 / 目击 / 听说 / 可察觉 / 不知：亲历、目击、听说是她通过这个渠道知道了；可察觉是表面痕迹摆在她面前，察没察觉不替她定。what（可省）写她知道或看到的是什么。
- weight 取 寻常 / 要紧 / 转折；转折事件永不压缩。shown 取 已呈现 / 仅痕迹 / 未呈现 / 待呈现。
- 可省：tags（标签数组）、because（因果上在先的事件 id 数组）、changed（一句话：它改变了什么处境或牵连）、confidence（0～1，只用于细节还没确定的幕外事件）、covers（摘要专用：覆盖的事件 id 数组）、corrects（更正专用：更正的是哪条事件的 id）。
样例（事件）：{"content": "林岚把三盒近效期抗凝药装进自己的包，报损单仍记十二盒。", "storyTime": "十月第三周 周四 17:40", "people": ["林岚", "小许"], "source": "裁定", "perceivers": [{"who": "林岚", "how": "亲历"}, {"who": "小许", "how": "可察觉", "what": "报损箱里只有九盒"}], "weight": "转折", "shown": "待呈现", "because": ["e05"], "changed": "林岚自记欠药房约 270 元"}
