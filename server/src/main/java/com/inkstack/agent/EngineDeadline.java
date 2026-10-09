package com.inkstack.agent;

import com.inkstack.ai.UpstreamDeadline;
import java.io.IOException;
import java.io.InputStream;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpRequest;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.client.ClientHttpRequestExecution;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.ClientHttpResponse;

/**
 * 一次<b>引擎交换</b>的绝对截止：覆盖整串模型往返，而不是其中任何一次。
 *
 * <p>为什么每次往返各自有超时还不够：{@code OpenAiChatModel.internalCall} 在执行完工具之后
 * <b>递归调用自己</b>，而 Spring AI 1.1.5 的字节码里没有任何迭代上限（字段、常量、字符串都没有）。
 * 于是"模型每轮都只回 {@code tool_calls}"这一个上游行为就能把循环转成无穷次——本机实测一次提问
 * 在服务端跑了 <b>200.1 秒、2192 轮</b>还没停，每轮都真敲一次全文检索、发给模型的 payload
 * 从 40KB 涨到 2.1MB。读者 25 秒就关了页面，之后它还又转了 583 轮。所以"轮数 × 每轮超时"
 * 在这里等于没有超时，必须有一条站在<b>整次交换</b>外面的截止。
 *
 * <p>机制照 {@link UpstreamDeadline}：到点从另一条线程把在飞的上游流 {@code close()}，
 * 阻塞中的 {@code read()} 当场抛 {@code IOException: closed}。差别只在"要关的东西"有几条——
 * 往返由 Spring 自己发起，我们拿不到它的循环，所以改成<b>登记</b>：把 {@link #interceptor()}
 * 挂到 RestClient 上，每个往返的响应体第一次交到读侧手上时就记进这一次交换，
 * 到点把它们全关掉。读侧（Spring）随后把那次 IOException 往上抛，
 * {@link AvatarEngine} 照既有的口径当成"引擎没产出"，落演示档、零扣墨。
 *
 * <p>{@link #close()} 里那句 {@code CURRENT.remove()} 不能省：这条线程是 Tomcat 池里的，
 * 下一个读者的请求会落在同一条线程上，留着的就是一个会提前掐死别人上游流的僵尸截止。
 */
public final class EngineDeadline implements AutoCloseable {

  private static final ThreadLocal<EngineDeadline> CURRENT = new ThreadLocal<>();

  private final Set<InputStream> inFlight = ConcurrentHashMap.newKeySet();
  private final UpstreamDeadline guard;

  private EngineDeadline(long timeoutMs) {
    this.guard = UpstreamDeadline.arm(this::killInFlight, timeoutMs);
  }

  /** 一次交换挂一个：引擎调用是同步的，从头到尾就在调用者这一条线程上，不存在嵌套。 */
  public static EngineDeadline arm(long timeoutMs) {
    EngineDeadline deadline = new EngineDeadline(timeoutMs);
    CURRENT.set(deadline);
    return deadline;
  }

  /** 挂到 {@code RestClient.builder()} 上的那个拦截器，整个客户端共用一个实例就够。 */
  public static ClientHttpRequestInterceptor interceptor() {
    return new Watcher();
  }

  /** 这次交换是不是被截止掐断的（截断与上游自己断了，在文案上要分开说）。 */
  public boolean stalled() {
    return guard.stalled();
  }

  /** 那句"N 秒没有回音"的数字来源，与透传/live 两条通道同一个旋钮。 */
  public String seconds() {
    return guard.seconds();
  }

  @Override
  public void close() {
    CURRENT.remove();
    guard.close();
    inFlight.clear();
  }

  /** 一条都没有关掉不等于一条都不用关：第一条就抛也不能把后面的留着继续占线程。 */
  private void killInFlight() throws IOException {
    IOException first = null;
    for (InputStream body : inFlight) {
      try {
        body.close();
      } catch (IOException broken) {
        if (first == null) {
          first = broken;
        }
      }
    }
    if (first != null) {
      throw first;
    }
  }

  /**
   * 登记一条在飞的响应体。截止与这句之间有缝（响应头刚到、还没记上就截止了），
   * 所以记下之后再看一眼标记：已经到点就当场关掉，别让它成为那条没人能掐的流。
   */
  private InputStream watch(InputStream body) {
    if (body == null) {
      return null;
    }
    inFlight.add(body);
    if (guard.stalled()) {
      try {
        body.close();
      } catch (IOException alreadyGone) {
        // 已经断了就是要的结果
      }
    }
    return body;
  }

  private static final class Watcher implements ClientHttpRequestInterceptor {

    @Override
    public ClientHttpResponse intercept(HttpRequest request, byte[] body,
        ClientHttpRequestExecution execution) throws IOException {
      ClientHttpResponse response = execution.execute(request, body);
      EngineDeadline deadline = CURRENT.get();
      return deadline == null ? response : new Watched(response, deadline);
    }
  }

  /** 只在 {@code getBody()} 上动了一下手，其余全部原样转给被包的那个响应。 */
  private static final class Watched implements ClientHttpResponse {

    private final ClientHttpResponse delegate;
    private final EngineDeadline deadline;

    private Watched(ClientHttpResponse delegate, EngineDeadline deadline) {
      this.delegate = delegate;
      this.deadline = deadline;
    }

    @Override
    public InputStream getBody() throws IOException {
      return deadline.watch(delegate.getBody());
    }

    @Override
    public HttpHeaders getHeaders() {
      return delegate.getHeaders();
    }

    @Override
    public HttpStatusCode getStatusCode() throws IOException {
      return delegate.getStatusCode();
    }

    @Override
    public String getStatusText() throws IOException {
      return delegate.getStatusText();
    }

    @Override
    public void close() {
      delegate.close();
    }
  }
}
